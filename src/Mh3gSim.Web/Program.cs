// ブラウザ専用 (JSExport / JSImport を使う)
[assembly: System.Runtime.Versioning.SupportedOSPlatform("browser")]

// 起動時の処理はない。worker.js が dotnet.js を読み込み、Api の JSExport を直接呼ぶ。
return;
