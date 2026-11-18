[CmdletBinding()]
param(
    [string]$Python = '',
    [string]$EnvFile = '.env',
    [string]$DataDir = '',
    [string]$Java = '',
    [string]$TlcJar = '',
    [int]$Port = 8000,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Python) {
    $Python = if ($env:PROVERYALKA_PYTHON) { $env:PROVERYALKA_PYTHON } else { Join-Path $ProjectRoot '.venv\Scripts\python.exe' }
}
# Individual arguments are passed directly; never Invoke-Expression or cmd /c.
Push-Location -LiteralPath $ProjectRoot
try {
    if (-not (Get-Command $Python -ErrorAction SilentlyContinue)) {
        throw 'Python environment missing. Run: py -3 -m venv .venv; .\.venv\Scripts\python.exe -m pip install -e ".[test,mcp]"'
    }
    if ($Java) { $env:PROVERYALKA_JAVA = $Java }
    if ($TlcJar) { $env:PROVERYALKA_TLA_JAR = $TlcJar }
    $LaunchArguments = @('-m', 'proveryalka.launch', '--env-file', $EnvFile, '--port', "$Port")
    if ($DataDir) { $LaunchArguments += @('--data-dir', $DataDir) }
    if ($CheckOnly) { $LaunchArguments += '--check-only' }
    & $Python @LaunchArguments
    $LaunchExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $LaunchExitCode
