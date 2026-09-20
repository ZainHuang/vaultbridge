$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.id -ne 'local-mirror-sync' -or $manifest.name -ne 'VaultBridge') { throw 'Unexpected plugin identity' }
$bundleRoot = Join-Path $projectRoot 'dist\vaultbridge'
$packageRoot = Join-Path $projectRoot ('artifacts\release-package-' + [guid]::NewGuid().ToString())
$pluginRoot = Join-Path $packageRoot $manifest.id
New-Item -ItemType Directory -Path $pluginRoot -Force | Out-Null
$files = @('main.js', 'manifest.json', 'styles.css')
foreach ($file in $files) {
    $source = Join-Path $bundleRoot $file
    if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath (Join-Path $projectRoot $file)).Hash) {
        throw "Stale build: $file. Run npm run build first."
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $pluginRoot $file)
}
$archive = Join-Path $bundleRoot ('vaultbridge-' + $manifest.version + '.zip')
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$archiveStream = [System.IO.File]::Open($archive, [System.IO.FileMode]::Create)
$zip = New-Object System.IO.Compression.ZipArchive($archiveStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files) {
        # ZIP paths use '/', including packages built on Windows for mobile users.
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $pluginRoot $file), ($manifest.id + '/' + $file)) | Out-Null
    }
} finally { $zip.Dispose(); $archiveStream.Dispose() }
$checksums = foreach ($file in ($files + [System.IO.Path]::GetFileName($archive))) {
    $hash = (Get-FileHash -LiteralPath (Join-Path $bundleRoot $file) -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $file"
}
[System.IO.File]::WriteAllLines((Join-Path $bundleRoot 'SHA256SUMS.txt'), $checksums)
Write-Output "Release assets: $bundleRoot"
