<#
.SYNOPSIS
Builds SWMM Studio locally: the front-end, then the release executable (or the installers).

.DESCRIPTION
Installs the front-end dependencies when needed (npm ci), builds the front-end (app/ui/dist,
embedded in the binary), then:
  - by default, `cargo build --release`: target/release/swmm-studio.exe, a standalone exe
    (it needs the WebView2 runtime, preinstalled on Windows 10/11);
  - with -Installers, `cargo tauri build`: the MSI and NSIS installers in
    target/release/bundle/ (needs the Tauri CLI: cargo install tauri-cli --version ^2).
With -Out, the exe (and the installers) are copied to that folder.

.EXAMPLE
./scripts/build-exe.ps1
./scripts/build-exe.ps1 -Installers -Out C:\Temp\swmm-studio
#>
[CmdletBinding()]
param(
    # Also make the MSI and NSIS installers (cargo tauri build).
    [switch]$Installers,
    # Run npm ci even when node_modules exists.
    [switch]$CleanInstall,
    # Folder the built files are copied to.
    [string]$Out
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ui = Join-Path $root 'app/ui'
$tauri = Join-Path $root 'app/src-tauri'

function Invoke-Step([string]$name, [string]$dir, [scriptblock]$cmd) {
    Write-Host "==> $name" -ForegroundColor Cyan
    Push-Location $dir
    try {
        & $cmd
        if ($LASTEXITCODE -ne 0) { throw "$name failed (exit code $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

foreach ($tool in 'npm', 'cargo') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool not found: install it first (see README)." }
}

if ($CleanInstall -or -not (Test-Path (Join-Path $ui 'node_modules'))) {
    Invoke-Step 'Front-end dependencies (npm ci)' $ui { npm ci }
}
# Type check and bundle into app/ui/dist.
Invoke-Step 'Front-end (npm run build)' $ui { npm run build }

if ($Installers) {
    cargo tauri --version *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Tauri CLI not found: cargo install tauri-cli --version ^2' }
    # The front-end is built already: skip the beforeBuildCommand of tauri.conf.json.
    $override = Join-Path ([IO.Path]::GetTempPath()) 'swmm-studio-build.json'
    '{ "build": { "beforeBuildCommand": "" } }' | Set-Content -Encoding utf8NoBOM $override
    try {
        Invoke-Step 'Executable and installers (cargo tauri build)' $tauri { cargo tauri build --config $override }
    } finally {
        Remove-Item $override -ErrorAction SilentlyContinue
    }
} else {
    Invoke-Step 'Executable (cargo build --release)' $root { cargo build --release -p swmm-studio }
}

$exe = Join-Path $root 'target/release/swmm-studio.exe'
if (-not (Test-Path $exe)) { throw "$exe was not built" }
$built = @(Get-Item $exe)
if ($Installers) {
    $built += Get-ChildItem (Join-Path $root 'target/release/bundle/msi/*.msi'), (Join-Path $root 'target/release/bundle/nsis/*.exe') -ErrorAction SilentlyContinue
}

if ($Out) {
    New-Item -ItemType Directory -Force $Out | Out-Null
    $built = $built | ForEach-Object { Copy-Item $_.FullName $Out -Force -PassThru }
}

Write-Host ''
Write-Host 'Built:' -ForegroundColor Green
$built | ForEach-Object { Write-Host ("  {0}  ({1:N1} MB)" -f $_.FullName, ($_.Length / 1MB)) }
