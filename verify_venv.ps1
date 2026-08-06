# verify_venv.ps1 — prove requirements.txt alone is enough to install and run.
#
#   powershell -ExecutionPolicy Bypass -File verify_venv.ps1
#
# Builds a throwaway virtual environment with nothing in it, installs ONLY what
# requirements.txt asks for, and then runs the engine and the GUI inside it. If
# a dependency is missing from requirements.txt this is where it shows up,
# rather than on someone else's PC.
#
# The shipped .exe needs none of this — it carries its own Python. This checks
# the source install path.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py   = "C:\Users\Zack\AppData\Local\Programs\Python\Python312\python.exe"
$venv = Join-Path $env:TEMP "sfpf_venv_test"
$fails = 0

function Check($name, $ok, $detail) {
    if ($ok) { Write-Host "[PASS] $name" -ForegroundColor Green }
    else { Write-Host "[FAIL] $name" -ForegroundColor Red; $script:fails++ }
    if ($detail) { Write-Host "       $detail" }
}

Write-Host "=== clean virtual environment ============================="
if (Test-Path $venv) { Remove-Item -Recurse -Force $venv }
& $py -m venv $venv
$vpy = Join-Path $venv "Scripts\python.exe"
Check "venv created" (Test-Path $vpy) $vpy
if (-not (Test-Path $vpy)) { exit 1 }

# nothing but pip in here to begin with
$before = (& $vpy -m pip list --format=freeze) -join ","
Write-Host "       starting packages: $before"

Write-Host "`n=== installing requirements.txt only ======================"
& $vpy -m pip install --disable-pip-version-check -q -r (Join-Path $root "requirements.txt")
Check "pip install -r requirements.txt succeeded" ($LASTEXITCODE -eq 0) "exit=$LASTEXITCODE"

Write-Host "`n=== engine works in the clean venv ========================"
Set-Location $root
$cli = & $vpy nameplate_cli.py --font "fonts/MerriweatherCut3Black-Engrave-v2.ttf" `
        --height 1 --unit in --basis cap --format both --mode per-name `
        --out (Join-Path $env:TEMP "sfpf_venv_out") ADAM 2>&1
$cliText = $cli -join "`n"
$expected = "ADAM: 4.053 x 1.015 in  |  6 cut contour(s), 10 engrave line(s)"
Check "CLI produces the documented numbers" ($cliText -match [regex]::Escape($expected)) `
      (($cli | Select-Object -First 1))

Write-Host "`n=== every app module imports in the clean venv ============"
$mods = @("nameplate_core","nameplate_leadin","nameplate_layout",
          "nameplate_eyelets","nameplate_fontcheck","nameplate_gui")
foreach ($m in $mods) {
    & $vpy -c "import $m" 2>&1 | Out-Null
    Check "import $m" ($LASTEXITCODE -eq 0) ""
}

Write-Host "`n=== GUI runs headless in the clean venv ==================="
$out = Join-Path $env:TEMP "sfpf_venv_selftest"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
& $vpy nameplate_gui.py --selftest $out 2>&1 | Select-Object -Last 3
$rep = Join-Path $out "selftest_report.txt"
if (Test-Path $rep) {
    $line = ((Get-Content -Encoding UTF8 $rep) | Select-String "^selftest: ").Line
    Check "GUI selftest passes in the venv" ($line -match "^selftest: (\d+)/\1 passed") $line
} else { Check "GUI selftest ran in the venv" $false "no report written" }

Write-Host "`n=========================================================="
if ($fails -eq 0) {
    Write-Host "requirements.txt is COMPLETE - a bare venv can run the app" -ForegroundColor Green
    exit 0
} else {
    Write-Host "$fails check(s) FAILED - requirements.txt is missing something" -ForegroundColor Red
    exit 1
}
