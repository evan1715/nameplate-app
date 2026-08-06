# verify_release.ps1 — prove the shipped zip works the way a new PC sees it.
#
#   powershell -ExecutionPolicy Bypass -File verify_release.ps1
#
# Extracts dist\SeansFontPrototypingFriend.zip into a clean folder — no build
# tree, no Python on PATH, nothing left over from this machine — then drives the
# extracted exe and checks the files it produces. This is the test that answers
# "does it run for someone who just unzipped it".
#
# Exit code 0 = every check passed.

$ErrorActionPreference = "Stop"
$root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$zip   = Join-Path $root "dist\SeansFontPrototypingFriend.zip"
$stage = Join-Path $env:TEMP "sfpf_release_test"
$fails = New-Object System.Collections.ArrayList
$passes = 0

function Check($name, $ok, $detail) {
    if ($ok) {
        $script:passes++
        Write-Host "[PASS] $name" -ForegroundColor Green
    } else {
        [void]$script:fails.Add("$name -> $detail")
        Write-Host "[FAIL] $name" -ForegroundColor Red
    }
    if ($detail) { Write-Host "       $detail" }
}

Write-Host "=== raw extraction test ==================================="
Check "release zip exists" (Test-Path $zip) $zip
if (-not (Test-Path $zip)) { Write-Host "nothing to test"; exit 1 }

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null

# extract exactly as Explorer's "Extract All" would
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $stage)
$app = Join-Path $stage "SeansFontPrototypingFriend"
$exe = Join-Path $app "SeansFontPrototypingFriend.exe"
Check "extracted app folder present" (Test-Path $exe) $exe
if (-not (Test-Path $exe)) { exit 1 }

foreach ($need in @("_internal", "fonts", "README.txt", "INSTALL.txt")) {
    Check "shipped: $need" (Test-Path (Join-Path $app $need)) ""
}
$fontCount = (Get-ChildItem (Join-Path $app "fonts") -File |
              Where-Object { $_.Extension -match '^\.(ttf|otf|ttc)$' }).Count
Check "fonts shipped next to the exe" ($fontCount -ge 1) "$fontCount font file(s)"
Check "no leftover settings.json in the release" `
      (-not (Test-Path (Join-Path $app "settings.json"))) ""

# ---- run the exe with Python stripped from the environment --------------- #
function Run-Exe($arguments, $timeoutSec) {
    $si = New-Object System.Diagnostics.ProcessStartInfo
    $si.FileName = $exe
    $si.Arguments = $arguments
    $si.UseShellExecute = $false
    $si.WorkingDirectory = $app
    $si.EnvironmentVariables.Clear()
    foreach ($k in @("SystemRoot","windir","TEMP","TMP","USERPROFILE","SystemDrive","LOCALAPPDATA")) {
        $v = (Get-Item "Env:$k" -ErrorAction SilentlyContinue).Value
        if ($v) { $si.EnvironmentVariables[$k] = $v }
    }
    $si.EnvironmentVariables["PATH"] = "$env:SystemRoot\system32;$env:SystemRoot"
    $pr = [System.Diagnostics.Process]::Start($si)
    if (-not $pr.WaitForExit($timeoutSec * 1000)) { $pr.Kill(); return 9999 }
    return $pr.ExitCode
}

Write-Host "`n=== driving the extracted exe (no Python on PATH) ========="
$out = Join-Path $app "verify_out"
$rc = Run-Exe "--selftest `"$out`"" 300
$report = Join-Path $out "selftest_report.txt"
Check "exe --selftest exit code 0" ($rc -eq 0) "exit=$rc"
Check "selftest report written" (Test-Path $report) $report
if (Test-Path $report) {
    $txt = Get-Content -Encoding UTF8 $report
    $line = ($txt | Select-String "^selftest: ").Line
    $allPass = $line -match "^selftest: (\d+)/\1 passed"
    Check "every selftest check passed" $allPass $line
    Check "splash was live at launch" `
          (($txt | Select-String "splash    = available").Count -ge 1) `
          (($txt | Select-String "splash").Line -join "; ")
    foreach ($feature in @("lists fonts", "preview size label", "canvas painted",
                           "per-name zip export", "one-sheet export",
                           "lead-ins appear", "lead-in export",
                           "Reload font", "font checker",
                           "a cut-only font does NOT warn",
                           "eyelet toggle fills actual",
                           "wanted eyelet ID draws the target ring",
                           "clearing a target box reads as nothing",
                           "thin mark's rank cannot be misread",
                           "Generate prompts produces one section",
                           "pair sheet zooms out and in",
                           "covers every positional junction",
                           "first-letter cell is shaped as 'dda'",
                           "last-letter cell is shaped as 'Aab'",
                           "middle row uses a medial glyph")) {
        Check "feature exercised: $feature" `
              (($txt | Select-String -SimpleMatch $feature).Count -ge 1) ""
    }
}

$rc = Run-Exe "--diagnose --quiet" 300
Check "exe --diagnose exit code 0" ($rc -eq 0) "exit=$rc"
$log = Join-Path $app "startup.log"
if (Test-Path $log) {
    $d = Get-Content -Encoding UTF8 $log
    Check "diagnose reports a healthy startup path" `
          (($d | Select-String "DIAGNOSE COMPLETE").Count -ge 1) `
          ($d | Select-Object -Last 1)
    Check "qt platform plugins present in the build" `
          (($d | Select-String "qwindows.dll").Count -ge 1) ""
}

# ---- the artefacts it produced ------------------------------------------- #
Write-Host "`n=== files the extracted exe produced ====================="
$zipOut = Join-Path $out "selftest_per_name.zip"
if (Test-Path $zipOut) {
    $z = [System.IO.Compression.ZipFile]::OpenRead($zipOut)
    $names = ($z.Entries | ForEach-Object { $_.FullName }) -join ","
    $z.Dispose()
    $want = "ADAM.pdf,ADAM.svg,Mary_Jane.pdf,Mary_Jane.svg,OLIVIA.pdf,OLIVIA.svg"
    $got = (($names -split "," | Sort-Object) -join ",")
    Check "per-name zip has one svg+pdf per name" ($got -eq $want) $got
} else { Check "per-name zip produced" $false "missing" }

foreach ($f in @("selftest_sheet.svg","selftest_sheet.pdf")) {
    $p = Join-Path $out $f
    $ok = (Test-Path $p) -and ((Get-Item $p).Length -gt 1000)
    Check "one-sheet output: $f" $ok $(if (Test-Path $p) { "$((Get-Item $p).Length) bytes" } else { "missing" })
}
$pdf = Join-Path $out "selftest_sheet.pdf"
if (Test-Path $pdf) {
    $head = [System.IO.File]::ReadAllBytes($pdf)[0..4]
    $sig = -join ($head | ForEach-Object { [char]$_ })
    Check "sheet PDF has a real PDF header" ($sig -eq "%PDF-") $sig
}
$svg = Join-Path $out "selftest_sheet.svg"
if (Test-Path $svg) {
    $s = Get-Content -Raw -Encoding UTF8 $svg
    Check "sheet SVG carries physical units" ($s -match 'width="[\d.]+in"') ""
    # The exporter writes per-name groups in CUTTING order: engrave first,
    # inner cuts, then the outline last so the part stays held until the end.
    Check "sheet SVG is per-name grouped in cutting order" `
          (($s -match '__1_engrave') -and ($s -match '__2_cut_inner') `
           -and ($s -match '__3_cut_outline') `
           -and ($s.IndexOf('__1_engrave') -lt $s.IndexOf('__3_cut_outline'))) ""
    Check "sheet SVG has no dimension marks to cut" `
          ((-not ($s -match "<text")) -and (-not ($s -match "<rect"))) ""
}
$png = Join-Path $out "selftest_window.png"
Check "window screenshot captured" (Test-Path $png) $png

Write-Host "`n=========================================================="
if ($fails.Count -eq 0) {
    Write-Host "ALL $passes CHECKS PASSED - the zip runs from a raw extraction" -ForegroundColor Green
    Write-Host "tested at: $app"
    exit 0
} else {
    Write-Host "$passes passed, $($fails.Count) FAILED" -ForegroundColor Red
    $fails | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}
