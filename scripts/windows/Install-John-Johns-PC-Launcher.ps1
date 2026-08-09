[CmdletBinding()]
param([switch]$Quiet)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$launcher = Join-Path $PSScriptRoot 'Open-John-Johns-PC.ps1'
$icon = Join-Path $projectRoot 'frontend\public\john-johns-pc-launcher.ico'
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $launcher) -or -not (Test-Path -LiteralPath $icon)) { throw "The launcher script or its icon is missing from $projectRoot." }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) "John John's PC.lnk"),
    (Join-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') "John John's PC.lnk")
)
foreach ($target in $targets) {
    $shortcut = $shell.CreateShortcut($target)
    $shortcut.TargetPath = $powerShell
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Description = "Open your local Pokemon TCG collection archive."
    $shortcut.WindowStyle = 7
    $shortcut.Save()
}

if (-not $Quiet) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("John John's PC is ready in the Start menu and on your desktop.", "John John's PC", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
}
