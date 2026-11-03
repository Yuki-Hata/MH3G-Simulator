// ブラウザ版の画面。Windows 版 (MainForm / CharmEditor) の操作をそのまま移し、検索は worker.js に任せる。

const AppTitle = 'MH3G スキルシミュレーター';
const MaxRequirements = 10;
const NoSkill = '（なし）';
const PartNames = ['頭', '胴', '腕', '腰', '脚'];
const CharmStorageKey = 'mh3g-skill-sim.charm';
const ExportTitlePlaceholder = '{{TITLE}}';

const $ = id => document.getElementById(id);

// ───────── 裏の検索 (Web Worker) ─────────

class CancelledError extends Error {
  constructor() { super('中止しました'); }
}

/**
 * worker.js とのやり取り。検索中の Worker は止められないので、中止は Worker ごと作り直す
 * (作り直した Worker は Init からやり直す。待っていた呼び出しは CancelledError で終わる)。
 */
class Engine {
  constructor(onProgress) {
    this.onProgress = onProgress;
    this.pending = new Map();
    this.nextId = 1;
  }

  /** Worker を起動して Init まで済ませる。結果は Init の内容。 */
  start() {
    const worker = new Worker('worker.js', { type: 'module' });
    this.worker = worker;
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = event => {
        const message = event.data;
        if (message.type === 'ready') return resolve();
        if (message.type === 'failed') return reject(new Error(message.error));
        if (message.type === 'progress') return this.onProgress(message.value);
        const call = this.pending.get(message.id);
        if (!call) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) call.reject(new Error(message.error));
        else call.resolve(message.result);
      };
      worker.onerror = event => {
        event.preventDefault();
        const error = new Error(event.message || '検索の準備に失敗しました');
        reject(error);
        this.rejectAll(error);
      };
    });
    this.booted = ready.then(() => this.send('Init')).then(text => JSON.parse(text));
    return this.booted;
  }

  /** 起動が済むのを待ってから呼ぶ (待っている間に作り直されたら、新しい方の起動を待つ)。 */
  async call(method, arg) {
    let booted;
    do {
      booted = this.booted;
      await booted;
    } while (booted !== this.booted);
    return this.send(method, arg);
  }

  send(method, arg) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, arg });
    });
  }

  restart() {
    this.worker.terminate();
    this.rejectAll(new CancelledError());
    return this.start();
  }

  rejectAll(error) {
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }
}

// ───────── 状態 ─────────

let init;
let shownSkills = [];
/** 追加したスキル ({ system, points, name, description })。 */
let requirements = [];
let results = [];
/** 表示中の結果がお守りの自動計算か。 */
let autoCharmResults = false;
/** 表示中の結果の全件保存用テキスト (見出しは保存時に入れる)。 */
let exportText = '';
let selectedIndex = -1;
/** 除外中の防具 (id → 名前)。 */
const excludedArmors = new Map();
let isSearching = false;
let catalogReady = false;
let charmLabelRequest = 0;

const engine = new Engine(percent => {
  if (isSearching) $('progress').value = percent;
});

// ───────── 起動 ─────────

boot();

async function boot() {
  if (typeof WebAssembly !== 'object' || typeof Worker !== 'function') {
    showLoadError('お使いのブラウザでは動きません。新しい版の Chrome / Edge / Safari / Firefox でお試しください。');
    return;
  }
  try {
    init = await engine.start();
  } catch (error) {
    showLoadError(`読み込みに失敗しました。ページを再読み込みしてください。\n(${error.message})`);
    return;
  }
  $('version').textContent = `v${init.version} ブラウザ版`;
  document.title = `${AppTitle} v${init.version}`;
  buildConditionPanel();
  buildResultPanel();
  refreshSkillList();
  renderRequirements();
  loadCharm();
  updateExcludedLabel();
  setStatus(`防具 ${init.armors} / 装飾品 ${init.decorations} / スキル系統 ${init.skillSystems}`);
  $('loading').hidden = true;
  $('app').hidden = false;
  warmup();
}

/** 実在するお守りの一覧を裏で作る (できるまで、お守りが出るテーブルの表示は「計算中」)。 */
async function warmup() {
  catalogReady = false;
  try {
    await engine.call('Warmup');
    catalogReady = true;
  } catch (error) {
    if (!(error instanceof CancelledError)) console.error(error);
  }
}

function showLoadError(message) {
  $('loadingText').textContent = message;
  $('loading').classList.add('error');
}

// ───────── 条件 ─────────

function buildConditionPanel() {
  for (const id of ['rarity', 'weaponSlots', 'maxResults']) {
    const input = $(id);
    input.addEventListener('change', () => { input.value = numberValue(input); });
  }

  const filter = $('skillFilter');
  filter.addEventListener('input', refreshSkillList);
  filter.addEventListener('focus', () => filter.select());
  filter.addEventListener('keydown', event => {
    // Enter で絞り込み結果の先頭を追加 (日本語入力の変換確定の Enter は除く)
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (shownSkills.length === 0) return;
    addSkill(shownSkills[0]);
    filter.value = '';
    refreshSkillList();
  });
  $('skillList').addEventListener('click', event => {
    const item = event.target.closest('li[data-index]');
    if (item) addSkill(shownSkills[Number(item.dataset.index)]);
  });
  $('requirementList').addEventListener('click', event => {
    const button = event.target.closest('button[data-index]');
    if (!button) return;
    requirements.splice(Number(button.dataset.index), 1);
    renderRequirements();
  });
  $('clearRequirements').addEventListener('click', () => {
    requirements = [];
    renderRequirements();
  });

  buildCharmEditor();
}

function numberValue(input) {
  const min = Number(input.min), max = Number(input.max);
  const value = Math.round(Number(input.value));
  if (input.value.trim() === '' || Number.isNaN(value)) return Number(input.defaultValue);
  return Math.min(max, Math.max(min, value));
}

function refreshSkillList() {
  const filter = $('skillFilter').value.trim();
  shownSkills = init.skills.filter(s => filter.length === 0 || s.name.includes(filter) || s.system.includes(filter));
  const list = $('skillList');
  list.replaceChildren(...shownSkills.map((skill, index) => {
    const item = document.createElement('li');
    item.dataset.index = index;
    item.title = skill.description;
    item.append(span('name', skill.name), span('sub', `${skill.system} ${skill.points}`));
    return item;
  }));
  if (shownSkills.length === 0) list.append(emptyItem('該当するスキルがありません'));
}

function addSkill(skill) {
  // 同じ系統は 1 つだけ (後から選んだものに置き換える)
  const existing = requirements.findIndex(r => r.system === skill.system);
  if (existing >= 0) requirements.splice(existing, 1);
  else if (requirements.length >= MaxRequirements) {
    alert(`スキルは最大 ${MaxRequirements} 個までです。`);
    return;
  }
  requirements.push(skill);
  renderRequirements();
  showDetail(`${skill.name}（${skill.system} ${skill.points}pt）\n${skill.description}`);
}

function renderRequirements() {
  const list = $('requirementList');
  list.replaceChildren(...requirements.map((skill, index) => {
    const item = document.createElement('li');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.dataset.index = index;
    remove.textContent = '×';
    remove.title = 'このスキルを外す';
    remove.setAttribute('aria-label', `${skill.name} を外す`);
    item.append(span('name', skill.name), span('sub', `${skill.system} ${skill.points}`), remove);
    return item;
  }));
  if (requirements.length === 0) list.append(emptyItem('まだありません'));
}

// ───────── お守り ─────────

function buildCharmEditor() {
  const table = $('charmTable');
  table.replaceChildren(option('すべて', ''), ...init.tables.map(t => option(String(t), String(t))));

  // 自動計算の時は入力欄を使わず、テーブルの絞り込みを使う
  const onMode = () => {
    const auto = $('charmAuto').checked;
    $('charmEditor').disabled = auto;
    table.disabled = !auto;
  };
  $('charmInput').addEventListener('change', onMode);
  $('charmAuto').addEventListener('change', onMode);

  $('skill1').addEventListener('change', () => { onSkill1Changed(); charmChanged(); });
  $('skill2').addEventListener('change', () => { onSkill2Changed(); charmChanged(); });
  for (const id of ['points1', 'slots', 'points2']) $(id).addEventListener('change', charmChanged);

  fill($('skill1'), [NoSkill, ...init.charm.first.map(s => s.skill)].map(s => option(s, s)));
  onSkill1Changed();
}

function onSkill1Changed() {
  const skill1 = $('skill1').value;
  const hasCharm = skill1 !== NoSkill;
  $('points1').disabled = $('slots').disabled = $('skill2').disabled = !hasCharm;

  const maximum = hasCharm ? init.charm.first.find(s => s.skill === skill1).max : 0;
  fill($('points1'), countDown(maximum, 1).map(pointOption));
  fill($('slots'), countUp(0, hasCharm ? init.charm.maxSlots : 0).map(v => option(String(v), String(v))), $('slots').selectedIndex);

  // 第 2 スキルは第 1 スキル以外から選ぶ。選択中のものは可能なら残す
  const previous = $('skill2').value || NoSkill;
  const options = hasCharm ? [NoSkill, ...init.charm.second.map(s => s.skill).filter(s => s !== skill1)] : [NoSkill];
  fill($('skill2'), options.map(s => option(s, s)), options.indexOf(previous));
  onSkill2Changed();
}

function onSkill2Changed() {
  const skill2 = $('skill2').value;
  const hasSkill2 = !$('skill2').disabled && skill2 !== '' && skill2 !== NoSkill;
  $('points2').disabled = !hasSkill2;
  const values = hasSkill2
    ? [...countDown(init.charm.second.find(s => s.skill === skill2).max, 1), ...countDown(-1, init.charm.secondMin)]
    : [];
  fill($('points2'), values.map(pointOption));
}

/** 装備中のお守り。スキル1 が「（なし）」なら null。 */
function currentCharm() {
  const skill1 = $('skill1').value;
  if (skill1 === NoSkill || $('points1').value === '') return null;
  const skill2 = $('skill2').value;
  const hasSkill2 = skill2 !== '' && skill2 !== NoSkill && $('points2').value !== '';
  return {
    skill1,
    points1: Number($('points1').value),
    skill2: hasSkill2 ? skill2 : '',
    points2: hasSkill2 ? Number($('points2').value) : 0,
    slots: Number($('slots').value) || 0,
  };
}

/** 保存済みのお守りを入力欄に入れる。選択肢に無い値 (データを直した後など) は近い値に寄せる。 */
function setCharm(charm) {
  if (selectValue($('skill1'), charm?.skill1 || NoSkill)) onSkill1Changed();
  selectNearestPoint($('points1'), charm?.points1 ?? 0);
  selectValue($('slots'), String(charm?.slots ?? 0));
  if (selectValue($('skill2'), charm?.skill2 || NoSkill)) onSkill2Changed();
  selectNearestPoint($('points2'), charm?.points2 ?? 0);
}

function loadCharm() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CharmStorageKey) ?? 'null'); } catch { /* 保存できない環境・壊れたデータは「なし」 */ }
  setCharm(saved);
  updateCharmTablesLabel();
}

function charmChanged() {
  try { localStorage.setItem(CharmStorageKey, JSON.stringify(currentCharm())); } catch { /* 保存できない環境では保存しない */ }
  updateCharmTablesLabel();
}

/** 入力中のお守りと同じスキル・ポイント・スロットのお守りが、どのテーブルに出るか。 */
async function updateCharmTablesLabel() {
  const label = $('charmTables');
  const request = ++charmLabelRequest;
  const charm = currentCharm();
  if (!charm) {
    label.textContent = '';
    return;
  }
  if (!catalogReady || isSearching) label.textContent = 'このお守りが出るテーブルを計算中…';
  try {
    const text = await engine.call('CharmTables', JSON.stringify(charm));
    if (request === charmLabelRequest) label.textContent = text;
  } catch (error) {
    // 中止で Worker を作り直した時は、作り直した後にもう一度呼ぶ
    if (!(error instanceof CancelledError) && request === charmLabelRequest) label.textContent = `表示できませんでした (${error.message})`;
  }
}

// ───────── 検索 ─────────

function buildResultPanel() {
  $('search').addEventListener('click', runSearch);
  $('cancel').addEventListener('click', cancelSearch);
  $('exportAll').addEventListener('click', saveAllResults);
  $('clearExcluded').addEventListener('click', () => {
    excludedArmors.clear();
    updateExcludedLabel();
  });

  const body = $('resultBody');
  body.addEventListener('click', event => {
    const row = event.target.closest('tr[data-index]');
    if (row) selectResult(Number(row.dataset.index));
  });
  body.addEventListener('contextmenu', event => {
    const row = event.target.closest('tr[data-index]');
    if (!row) return;
    // 右クリックした行を選んでからメニューを出す (コピー・除外が対象の行に効くように)
    event.preventDefault();
    selectResult(Number(row.dataset.index));
    showContextMenu(event.clientX, event.clientY);
  });
  $('tableWrap').addEventListener('keydown', event => {
    if (results.length === 0 || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    const next = selectedIndex < 0 ? 0 : selectedIndex + (event.key === 'ArrowDown' ? 1 : -1);
    selectResult(Math.min(results.length - 1, Math.max(0, next)));
  });

  const excludeButtons = $('excludeButtons');
  PartNames.forEach((part, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = part;
    button.title = `この${part}防具を除外して再検索`;
    button.addEventListener('click', () => excludeAndSearch(index));
    excludeButtons.append(button);
  });
  $('copyOne').addEventListener('click', copySelectedResult);
  $('saveOne').addEventListener('click', saveSelectedResult);

  const menu = $('contextMenu');
  const items = PartNames.map((part, index) => menuItem(`この${part}防具を除外して再検索`, () => excludeAndSearch(index)));
  const separator = document.createElement('li');
  separator.className = 'separator';
  menu.append(...items, separator,
    menuItem('この結果をコピー', copySelectedResult),
    menuItem('この結果をテキスト保存', saveSelectedResult));
  const hide = () => { menu.hidden = true; };
  document.addEventListener('click', hide);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  document.addEventListener('scroll', hide, true);
}

function excludeAndSearch(part) {
  if (selectedIndex < 0) return;
  const armor = results[selectedIndex].armors[part];
  excludedArmors.set(armor.id, armor.name);
  updateExcludedLabel();
  runSearch();
}

async function runSearch() {
  if (isSearching) return;
  if (requirements.length === 0) {
    alert('欲しいスキルを 1 つ以上追加してください。');
    return;
  }
  const autoCharm = $('charmAuto').checked;
  const table = $('charmTable').value;
  const request = {
    requirements: requirements.map(r => ({ system: r.system, points: r.points, name: r.name })),
    isGunner: $('class').selectedIndex === 1,
    isFemale: $('gender').selectedIndex === 1,
    maxRarity: numberValue($('rarity')),
    weaponSlots: numberValue($('weaponSlots')),
    autoCharm,
    charm: autoCharm ? null : currentCharm(),
    table: autoCharm && table !== '' ? Number(table) : null,
    avoidNegativeSkills: $('avoidNegative').checked,
    excludedArmorIds: [...excludedArmors.keys()],
    maxResults: numberValue($('maxResults')),
  };

  setSearching(true);
  try {
    const response = JSON.parse(await engine.call('Search', JSON.stringify(request)));
    results = response.rows;
    autoCharmResults = response.autoCharm;
    exportText = response.export;
    setStatus(response.status);
  } catch (error) {
    if (!(error instanceof CancelledError)) {
      setSearching(false);
      alert(`検索エラー\n${error.message}`);
      return;
    }
    // 結果の一覧は前回の検索のまま残る (今回の条件の結果と見間違えないように書く)
    setStatus(results.length > 0 ? '中止しました (表示は前回の検索結果)' : '中止しました');
  } finally {
    setSearching(false);
  }
  showResults();
  if (window.matchMedia('(max-width: 999px)').matches) $('results').scrollIntoView({ behavior: 'smooth' });
}

async function cancelSearch() {
  if (!isSearching) return;
  const booted = engine.restart();
  catalogReady = false;
  try {
    await booted;
  } catch (error) {
    setStatus(`検索の準備に失敗しました。ページを再読み込みしてください。(${error.message})`);
    return;
  }
  warmup();
  updateCharmTablesLabel();
}

function setSearching(searching) {
  isSearching = searching;
  $('search').disabled = searching;
  $('cancel').disabled = !searching;
  $('exportAll').disabled = searching || results.length === 0;
  $('progress').value = 0;
  if (searching) setStatus('検索中…');
}

function setStatus(text) {
  $('status').textContent = text;
}

function showResults() {
  $('exportAll').disabled = results.length === 0;
  const tableElement = $('resultBody').closest('table');
  tableElement.classList.toggle('auto', autoCharmResults);
  $('charmHeader').textContent = autoCharmResults ? '必要なお守り (以上)' : 'お守り';
  $('resultBody').replaceChildren(...results.map((result, index) => {
    const row = document.createElement('tr');
    row.dataset.index = index;
    const cells = [
      [String(index + 1), 'num'], [result.defense],
      ...result.armors.map(a => [a.name]),
      [result.charm], [result.kinds, 'auto-only'], [result.tables, 'auto-only'], [result.free],
    ];
    for (const [text, className] of cells) {
      const cell = document.createElement('td');
      if (className) cell.className = className;
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  }));
  selectedIndex = -1;
  $('selectionActions').hidden = true;
  $('tableWrap').scrollTop = 0;
  if (results.length > 0) selectResult(0);
  else {
    showDetail(autoCharmResults
      ? '実在するお守りを使っても、条件を満たす組み合わせが見つかりませんでした。\nレア度上限・武器スロット・スキルを見直してください。'
      : '条件を満たす組み合わせが見つかりませんでした。\nレア度上限・武器スロット・お守りを見直してください。');
  }
}

function selectResult(index) {
  const rows = $('resultBody').rows;
  if (selectedIndex >= 0 && rows[selectedIndex]) rows[selectedIndex].classList.remove('selected');
  selectedIndex = index;
  const row = rows[index];
  row.classList.add('selected');
  row.scrollIntoView({ block: 'nearest' });
  $('selectionActions').hidden = false;
  showDetail(results[index].detail);
}

function showDetail(text) {
  const detail = $('detail');
  detail.textContent = text;
  detail.scrollTop = 0;
}

function updateExcludedLabel() {
  $('excluded').textContent = excludedArmors.size === 0 ? '' : `除外中: ${[...excludedArmors.values()].join(', ')}`;
}

function showContextMenu(x, y) {
  const menu = $('contextMenu');
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height - 4))}px`;
}

// ───────── テキスト出力 ─────────

async function copySelectedResult() {
  if (selectedIndex < 0) return;
  const text = results[selectedIndex].detail;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // クリップボードの機能が使えない環境向け
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  setStatus('選択中の結果をコピーしました');
}

function saveSelectedResult() {
  if (selectedIndex < 0) return;
  const number = selectedIndex + 1;
  const content = `${AppTitle} v${init.version}  No.${number}\n\n${results[selectedIndex].detail}`;
  saveText(`MH3G装備_No${number}_${timestamp()}.txt`, content);
}

function saveAllResults() {
  if (results.length === 0) return;
  const title = `${AppTitle} v${init.version} 検索結果 (${formatDate(new Date(), true)})`;
  saveText(`MH3G検索結果_${timestamp()}.txt`, exportText.replace(ExportTitlePlaceholder, title));
}

function saveText(fileName, content) {
  // メモ帳などで文字化けしないよう BOM 付き UTF-8、改行は Windows 版と同じ CRLF
  const blob = new Blob(['﻿' + content.replace(/\r?\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  setStatus(`保存しました: ${fileName}`);
}

function timestamp() {
  return formatDate(new Date(), false);
}

/** 見出し用は「2026-09-24 21:05」、ファイル名用は「20260924_2105」。 */
function formatDate(date, forTitle) {
  const pad = n => String(n).padStart(2, '0');
  const [y, m, d, h, min] = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()), pad(date.getHours()), pad(date.getMinutes())];
  return forTitle ? `${y}-${m}-${d} ${h}:${min}` : `${y}${m}${d}_${h}${min}`;
}

// ───────── 小物 ─────────

/** from, from+1, …, to (from > to なら空)。 */
function countUp(from, to) {
  const values = [];
  for (let v = from; v <= to; v++) values.push(v);
  return values;
}

/** from, from-1, …, to (from < to なら空)。 */
function countDown(from, to) {
  return countUp(to, from).reverse();
}

function option(label, value) {
  const element = document.createElement('option');
  element.textContent = label;
  element.value = value;
  return element;
}

function pointOption(value) {
  return option(value > 0 ? `+${value}` : String(value), String(value));
}

function fill(select, options, selectedIndex = 0) {
  select.replaceChildren(...options);
  if (options.length > 0) select.selectedIndex = Math.min(options.length - 1, Math.max(0, selectedIndex));
}

/** 選択肢に value があれば選ぶ。選んだら true。 */
function selectValue(select, value) {
  const index = [...select.options].findIndex(o => o.value === value);
  if (index < 0) return false;
  select.selectedIndex = index;
  return true;
}

function selectNearestPoint(select, value) {
  // 最大値を超える値 (データを小さく直した時など) は選べる中で一番近い値にする
  const options = [...select.options];
  if (options.length === 0) return;
  let best = 0;
  options.forEach((o, i) => {
    if (Math.abs(Number(o.value) - value) < Math.abs(Number(options[best].value) - value)) best = i;
  });
  select.selectedIndex = best;
}

function span(className, text) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function emptyItem(text) {
  const item = document.createElement('li');
  item.className = 'empty';
  item.textContent = text;
  return item;
}

function menuItem(text, action) {
  const item = document.createElement('li');
  item.setAttribute('role', 'menuitem');
  item.textContent = text;
  item.addEventListener('click', action);
  return item;
}
