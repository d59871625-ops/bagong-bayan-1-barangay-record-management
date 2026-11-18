$ErrorActionPreference = 'Stop'

$phpCommand = Get-Command php -ErrorAction SilentlyContinue
$phpPath = if ($phpCommand) { $phpCommand.Source } else { $null }

if (-not $phpPath) {
    $laragonRoot = if ($env:LARAGON_ROOT) { $env:LARAGON_ROOT } else { 'C:\laragon' }
    $phpDirectory = Join-Path $laragonRoot 'bin\php'
    $phpPath = Get-ChildItem -Path $phpDirectory -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'php.exe' } |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1
}

if (-not $phpPath) {
    throw 'PHP CLI was not found. Start Laragon or set LARAGON_ROOT to its installation folder.'
}

Write-Host "Serving the local PHP API at http://127.0.0.1:8000"
Write-Host 'Press Ctrl+C to stop the API server.'
& $phpPath -S 127.0.0.1:8000 -t $PSScriptRoot