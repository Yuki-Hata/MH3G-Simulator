# Cemu の graphicPacks フォルダに、このグラフィックパックをコピーする。
# 既にある場合は、このパックのファイルだけを新しいものに置き換える。
param(
    # Cemu のユーザーフォルダ (Cemu のメニュー「ファイル → Open Cemu folder」で開くフォルダ)
    [string]$CemuUserDir = (Join-Path $env:APPDATA 'Cemu')
)
$ErrorActionPreference = 'Stop'

$packName = 'MH3G_CharmTableReroll'
$source = Join-Path $PSScriptRoot "..\graphicPack\$packName"
$graphicPacks = Join-Path $CemuUserDir 'graphicPacks'
if (-not (Test-Path -LiteralPath $graphicPacks)) {
    throw "graphicPacks フォルダが見つかりません: $graphicPacks (-CemuUserDir で Cemu のユーザーフォルダを指定してください)"
}

$target = Join-Path $graphicPacks $packName
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $target -Force
Get-ChildItem -LiteralPath $target | Select-Object Name, Length | Format-Table -AutoSize
Write-Host "コピーしました: $target"
Write-Host 'Cemu の「設定 → グラフィック パック」で Charm Table Reroll (JP 3G HD) にチェックを入れて、ゲームを起動し直してください。'
