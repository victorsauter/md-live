# Renders media/logo.svg to media/icon.png (128x128, transparent corners) with headless Microsoft Edge.
# Usage (Windows, from the repository root): pwsh scripts/generate-icon.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$svg = Join-Path $root 'media\logo.svg'
$png = Join-Path $root 'media\icon.png'
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge was not found.' }
$profileDir = Join-Path ([IO.Path]::GetTempPath()) "live-markdown-icon-$PID"
try {
  $url = 'file:///' + ($svg -replace '\\', '/')
  $edgeArgs = @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', "--user-data-dir=$profileDir",
    '--default-background-color=00000000', '--window-size=128,128', "--screenshot=$png", $url)
  Start-Process -FilePath $edge -ArgumentList $edgeArgs -Wait -WindowStyle Hidden
} finally {
  Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
}
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($png)
try {
  if ($image.Width -ne 128 -or $image.Height -ne 128) { throw "Unexpected size $($image.Width)x$($image.Height)" }
} finally { $image.Dispose() }
"saved $png"
