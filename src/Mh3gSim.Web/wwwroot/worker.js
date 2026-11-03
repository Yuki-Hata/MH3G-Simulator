// 検索ロジック (.NET の WebAssembly) を画面とは別のスレッドで動かす。
// 画面からは { id, method, arg } が届き、Api の同名のメソッドを呼んで { id, result } か { id, error } を返す。
// 検索中の進捗は { type: 'progress', value } で送る。
import { dotnet } from './_framework/dotnet.js';

try {
  const runtime = await dotnet.withApplicationCulture('ja-JP').create();
  runtime.setModuleImports('worker.js', {
    reportProgress: percent => postMessage({ type: 'progress', value: percent }),
  });
  const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
  const api = exports.Mh3gSim.Web.Api;

  self.onmessage = event => {
    const { id, method, arg } = event.data;
    try {
      const result = arg === undefined ? api[method]() : api[method](arg);
      postMessage({ id, result });
    } catch (error) {
      postMessage({ id, error: String(error?.message ?? error) });
    }
  };
  postMessage({ type: 'ready' });
} catch (error) {
  postMessage({ type: 'failed', error: String(error?.message ?? error) });
}
