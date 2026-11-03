using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using System.Text.Json.Serialization;
using Mh3gSim.Core;

namespace Mh3gSim.Web;

/// <summary>
/// ブラウザ版の検索の窓口。worker.js (Web Worker) から呼ばれ、画面 (main.js) とは JSON の文字列でやり取りする。
/// 検索中は Worker が止まるので、中止は画面側で Worker ごと作り直して行う (CancellationToken は使わない)。
/// Windows 版 (MainForm) の検索・表示の組み立てをそのまま移したもの。
/// </summary>
public static partial class Api
{
    private const int CharmExampleCount = 3;
    /// <summary>全件保存の見出し。保存した時刻を入れるため、画面側で置き換える。</summary>
    private const string ExportTitlePlaceholder = "{{TITLE}}";

    private static GameData data = null!;
    private static SkillSearcher searcher = null!;
    private static CharmCatalog charmCatalog = null!;
    private static CharmFinder charmFinder = null!;

    /// <summary>データを読み込み、画面の選択肢 (スキル一覧・お守りの選択肢・テーブル番号) を返す。</summary>
    [JSExport]
    public static string Init()
    {
        // 系統名の並びを Windows 版 (日本語環境) と同じにする
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("ja-JP");
        data = GameData.LoadEmbedded();
        searcher = new SkillSearcher(data);
        charmCatalog = new CharmCatalog(data.Charms);
        charmFinder = new CharmFinder(searcher);

        var limits = CharmLimits.From(data.Charms);
        var skills = data.SkillSystems
            .SelectMany(s => s.Activations.Where(a => a.Points > 0).Select(a => new SkillDto(s.System, a.Points, a.Name, a.Description)))
            .OrderBy(i => i.System).ThenByDescending(i => i.Points)
            .ToList();
        // お守りの選択肢の並びはスキル一覧 (skills.json) の順
        var systems = data.SkillSystems.Select(s => s.System).ToList();
        var init = new InitDto(
            typeof(Api).Assembly.GetName().Version is { } v ? $"{v.Major}.{v.Minor}.{v.Build}" : "?",
            data.Armors.Count, data.Decorations.Count, data.SkillSystems.Count,
            skills,
            new CharmOptionsDto(
                systems.Where(limits.FirstSkillMax.ContainsKey).Select(s => new CharmSkillDto(s, limits.FirstSkillMax[s])).ToList(),
                systems.Where(limits.SecondSkillMax.ContainsKey).Select(s => new CharmSkillDto(s, limits.SecondSkillMax[s])).ToList(),
                limits.SecondSkillMin, limits.MaxSlots),
            charmCatalog.TableNumbers);
        return JsonSerializer.Serialize(init, WebJson.Default.InitDto);
    }

    /// <summary>実在するお守りの一覧を作っておく (初回の表示・自動計算を待たせないため、起動直後に呼ぶ)。</summary>
    [JSExport]
    public static int Warmup() => charmCatalog.Entries.Count;

    /// <summary>入力中のお守りと同じスキル・ポイント・スロットのお守りが、どのテーブルに出るか (お守りなしなら空文字)。</summary>
    [JSExport]
    public static string CharmTables(string charmJson)
    {
        var charm = ToCharm(JsonSerializer.Deserialize(charmJson, WebJson.Default.CharmDto));
        if (charm.IsNone) return "";
        var same = charmCatalog.FindSame(charm);
        if (same.Count == 0) return "このお守りはどのテーブルにも出ません (スキルの順番・ポイント・スロットを確かめてください)";
        var tables = charmCatalog.TableNumbers.Where(t => same.Any(e => e.AppearsOn(t))).ToList();
        var names = string.Join("・", same.Select(e => e.Name).Distinct());
        return $"このお守りが出るテーブル: {ResultTextFormatter.FormatTables(tables, charmCatalog.TableNumbers)} ({names})";
    }

    [JSExport]
    public static string Search(string requestJson)
    {
        var request = JsonSerializer.Deserialize(requestJson, WebJson.Default.SearchRequestDto)!;
        var requirements = request.Requirements.Select(r => new SkillRequirement(r.System, r.Points, r.Name)).ToList();
        var condition = new SearchCondition
        {
            Requirements = requirements,
            IsGunner = request.IsGunner,
            IsFemale = request.IsFemale,
            MaxRarity = request.MaxRarity,
            WeaponSlots = request.WeaponSlots,
            Charms = request.AutoCharm ? [] : [ToCharm(request.Charm)],
            AvoidNegativeSkills = request.AvoidNegativeSkills,
            ExcludedArmorIds = [.. request.ExcludedArmorIds],
            MaxResults = request.MaxResults,
        };

        var progress = new ProgressReporter();
        var watch = Stopwatch.StartNew();
        List<SearchResult> results;
        List<CharmSuggestion>? suggestions = null;
        int truncatedSolves;
        string status;
        if (request.AutoCharm)
        {
            var table = request.Table;
            var candidates = charmCatalog.RequirementsFor(requirements, table);
            var found = charmFinder.Find(condition, candidates, progress, CancellationToken.None);
            suggestions = found.Suggestions.Take(condition.MaxResults)
                .Select(s => s with { Availability = charmCatalog.Describe(s.Requirement, requirements, table, CharmExampleCount) })
                .ToList();
            results = suggestions.Select(s => s.Best).ToList();
            truncatedSolves = found.TruncatedSolves;
            var where = table is { } only ? $"テーブル {only} で" : "実在する";
            status = suggestions switch
            {
                [] => $"{where}お守りでは成立しません",
                [{ Requirement.IsZero: true }] => "お守りなしで成立します",
                _ => $"必要なお守り {suggestions.Count} 通り{(table is { } shown ? $" (テーブル {shown})" : "")}",
            };
        }
        else
        {
            var outcome = searcher.Search(condition, progress, CancellationToken.None);
            results = outcome.Results;
            truncatedSolves = outcome.TruncatedSolves;
            status = $"{results.Count} 件";
        }
        status += $" ({watch.Elapsed.TotalSeconds:0.0} 秒)"
            + (truncatedSolves > 0 ? $"  ※珠の探索を {truncatedSolves} 構成で打ち切り (見落としの可能性あり)" : "");

        var rows = results.Select((r, i) =>
        {
            string charm, kinds = "", tables = "", detail;
            if (suggestions != null)
            {
                var suggestion = suggestions[i];
                var shown = !suggestion.Requirement.IsZero && suggestion.Availability != null;
                charm = ResultTextFormatter.ShortRequirement(suggestion.Requirement, requirements);
                if (shown)
                {
                    kinds = string.Join("・", suggestion.Availability!.Kinds.Select(k => k.Replace("お守り", "")));
                    tables = ResultTextFormatter.FormatTables(suggestion.Availability.Tables, charmCatalog.TableNumbers);
                }
                detail = ResultTextFormatter.FormatSuggestion(suggestion, requirements, condition.WeaponSlots, charmCatalog.TableNumbers);
            }
            else
            {
                charm = r.Charm.ToString();
                detail = ResultTextFormatter.FormatResult(r, condition.WeaponSlots);
            }
            return new ResultRowDto(
                $"{r.Defense}→{r.MaxDefense}",
                r.Armors.Select(a => new ArmorDto(a.Id, a.Name)).ToList(),
                charm, kinds, tables, string.Join(" ", r.FreeSlots), detail);
        }).ToList();

        var export = ResultTextFormatter.FormatExport(condition, results, ExportTitlePlaceholder, suggestions == null
            ? null
            : new ResultTextFormatter.CharmSearchContext(suggestions, request.Table, charmCatalog.TableNumbers));
        return JsonSerializer.Serialize(new SearchResponseDto(request.AutoCharm, status, rows, export), WebJson.Default.SearchResponseDto);
    }

    private static Charm ToCharm(CharmDto? charm) => charm == null || string.IsNullOrEmpty(charm.Skill1)
        ? Charm.None
        : new Charm
        {
            Skill1 = charm.Skill1,
            Points1 = charm.Points1,
            Skill2 = charm.Skill2 ?? "",
            Points2 = string.IsNullOrEmpty(charm.Skill2) ? 0 : charm.Points2,
            Slots = charm.Slots,
        };

    [JSImport("reportProgress", "worker.js")]
    private static partial void ReportProgress(int percent);

    /// <summary>検索の進捗を画面へ送る (同じ % は送らない)。検索と同じスレッドでそのまま呼ぶ。</summary>
    private sealed class ProgressReporter : IProgress<double>
    {
        private int last = -1;

        public void Report(double value)
        {
            var percent = Math.Clamp((int)(value * 100), 0, 100);
            if (percent == last) return;
            last = percent;
            ReportProgress(percent);
        }
    }
}

public sealed record SkillDto(string System, int Points, string Name, string Description);
public sealed record CharmSkillDto(string Skill, int Max);
public sealed record CharmOptionsDto(List<CharmSkillDto> First, List<CharmSkillDto> Second, int SecondMin, int MaxSlots);
public sealed record InitDto(string Version, int Armors, int Decorations, int SkillSystems, List<SkillDto> Skills,
    CharmOptionsDto Charm, IReadOnlyList<int> Tables);

public sealed record CharmDto(string Skill1, int Points1, string? Skill2, int Points2, int Slots);
public sealed record RequirementDto(string System, int Points, string Name);
public sealed record SearchRequestDto(
    List<RequirementDto> Requirements, bool IsGunner, bool IsFemale, int MaxRarity, int WeaponSlots,
    bool AutoCharm, CharmDto? Charm, int? Table, bool AvoidNegativeSkills, List<int> ExcludedArmorIds, int MaxResults);

public sealed record ArmorDto(int Id, string Name);
public sealed record ResultRowDto(string Defense, List<ArmorDto> Armors, string Charm, string Kinds, string Tables, string Free, string Detail);
public sealed record SearchResponseDto(bool AutoCharm, string Status, List<ResultRowDto> Rows, string Export);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(InitDto))]
[JsonSerializable(typeof(CharmDto))]
[JsonSerializable(typeof(SearchRequestDto))]
[JsonSerializable(typeof(SearchResponseDto))]
internal sealed partial class WebJson : JsonSerializerContext;
