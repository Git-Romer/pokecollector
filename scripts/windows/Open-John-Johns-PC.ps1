[CmdletBinding()]
param([switch]$NoBrowser)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$localUrl = 'http://127.0.0.1:13000/'
$composeFiles = @('-f', (Join-Path $projectRoot 'docker-compose.yml'), '-f', (Join-Path $projectRoot 'docker-compose.local.yml'))
Add-Type -AssemblyName System.Windows.Forms

function Show-ArchivePrompt {
    param([string]$Message)
    [System.Windows.Forms.MessageBox]::Show($Message, "John John's PC", [System.Windows.Forms.MessageBoxButtons]::RetryCancel, [System.Windows.Forms.MessageBoxIcon]::Information)
}

function Test-DockerReady {
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) { return $false }
    $stdout = Join-Path $env:TEMP "jjpc-docker-$PID.out"
    $stderr = Join-Path $env:TEMP "jjpc-docker-$PID.err"
    try {
        $process = Start-Process -FilePath $docker.Source -ArgumentList @('version', '--format', '{{.Server.Version}}') -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        if (-not $process.WaitForExit(6000)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            return $false
        }
        return $process.ExitCode -eq 0 -and (Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue).Trim().Length -gt 0
    }
    finally {
        Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue
    }
}

while (-not (Test-DockerReady)) {
    $result = Show-ArchivePrompt -Message "John John's PC is waiting for Docker Desktop. Open Docker Desktop and wait for it to finish starting, then choose Retry.`n`nThis launcher never changes Windows services automatically."
    if ($result -ne [System.Windows.Forms.DialogResult]::Retry) { exit 1 }
}

Push-Location $projectRoot
try {
    & docker compose @composeFiles up -d
    if ($LASTEXITCODE -ne 0) { throw 'The local collection stack could not be started.' }
}
catch {
    [System.Windows.Forms.MessageBox]::Show("John John's PC could not start the local collection stack.`n`n$($_.Exception.Message)", "John John's PC", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    exit 1
}
finally { Pop-Location }

for ($attempt = 1; $attempt -le 45; $attempt++) {
    try {
        $response = Invoke-WebRequest -Uri $localUrl -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
            if (-not $NoBrowser) { Start-Process $localUrl }
            exit 0
        }
    }
    catch { Start-Sleep -Seconds 1 }
}

[System.Windows.Forms.MessageBox]::Show("The collection stack started, but the archive did not respond within 45 seconds. Run John John's PC again after Docker finishes its startup work.", "John John's PC", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
exit 1
