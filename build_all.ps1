# build_all.ps1 — produce every shippable artifact from a clean state.
#
#   powershell -ExecutionPolicy Bypass -File build_all.ps1
#
# Outputs:
#   dist_installer\SeansFontPrototypingFriend-Setup.exe   <- recommended
#   dist\SeansFontPrototypingFriend.zip                   <- portable folder
#   dist_single\SeansFontPrototypingFriend-SingleFile.exe  <- one file, no install
#
# Run verify_release.ps1 afterwards to prove the zip works from a raw extraction.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$py = "C:\Users\Zack\AppData\Local\Programs\Python\Python312\python.exe"
$iscc = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
$dist = "dist\SeansFontPrototypingFriend"

function Say($m) { Write-Host "`n=== $m" -ForegroundColor Cyan }

Say "0. regenerate icon + splash from assets\logo.png"
& $py make_assets.py
if ($LASTEXITCODE -ne 0) { throw "make_assets.py failed" }

Say "0b. stamp the build so the exe can prove which code it is"
& $py make_manifest.py
if ($LASTEXITCODE -ne 0) { throw "make_manifest.py failed" }

Say "1. tests must pass before anything is built"
# ALL of them. This used to run acceptance_tests only, which meant the suite
# that proves the CorelDRAW-verified export contract (per-name groups, cut order
# engrave -> inner -> outline) never ran before the installer was packaged, and
# neither did the regressions. Combined they cost well under a minute.
foreach ($suite in @("acceptance_tests.py", "export_tests.py",
                     "regression_tests.py")) {
    & $py $suite | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { throw "$suite FAILED - not building" }
}

Say "2. clean previous output"
foreach ($d in @("build", "dist", "dist_single", "dist_installer")) {
    if (Test-Path $d) { Remove-Item -Recurse -Force $d }
}
# stray run-time files must never be packaged
foreach ($f in @("settings.json", "startup.log")) {
    if (Test-Path $f) { Remove-Item -Force $f }
}

Say "3. folder build (fast launch)"
& $py -m PyInstaller --noconfirm --onedir --windowed --noupx `
    --name SeansFontPrototypingFriend `
    --icon "assets/icon.ico" --splash "assets/splash.png" `
    --add-data "fonts;fonts" --add-data "assets;assets" `
    nameplate_gui.py | Select-Object -Last 1
if (-not (Test-Path "$dist\SeansFontPrototypingFriend.exe")) { throw "onedir build failed" }

Say "4. stage the writable fonts folder and the docs beside the exe"
Copy-Item -Recurse -Force "fonts" (Join-Path $dist "fonts")
Copy-Item -Force "README_APP.txt" (Join-Path $dist "README.txt")
Copy-Item -Force "INSTALL.txt" $dist

Say "5. prove the freshly built exe works, then strip what the test created"
$st = Join-Path $dist "_buildcheck"
$p = Start-Process -FilePath (Join-Path $dist "SeansFontPrototypingFriend.exe") `
     -ArgumentList "--selftest", "`"$st`"" -Wait -PassThru
$line = ((Get-Content -Encoding UTF8 (Join-Path $st "selftest_report.txt")) |
         Select-String "^selftest: ").Line
Write-Host "    $line"
if ($p.ExitCode -ne 0 -or $line -notmatch "^selftest: (\d+)/\1 passed") {
    throw "the built exe FAILED its own selftest - not packaging"
}
Remove-Item -Recurse -Force $st
foreach ($f in @("settings.json", "startup.log")) {
    $t = Join-Path $dist $f
    if (Test-Path $t) { Remove-Item -Force $t }
}

Say "6. portable zip"
Compress-Archive -Path $dist -DestinationPath "dist\SeansFontPrototypingFriend.zip" `
    -CompressionLevel Optimal

Say "7. single-file build (one file, nothing to extract)"
& $py -m PyInstaller --noconfirm --onefile --windowed --noupx `
    --name SeansFontPrototypingFriend-SingleFile `
    --icon "assets/icon.ico" --splash "assets/splash.png" `
    --add-data "fonts;fonts" --add-data "assets;assets" `
    --distpath "dist_single" nameplate_gui.py | Select-Object -Last 1

Say "8. installer"
if (Test-Path $iscc) {
    & $iscc installer.iss | Select-Object -Last 3
} else {
    Write-Host "    Inno Setup not found - skipping installer." -ForegroundColor Yellow
    Write-Host "    winget install --id JRSoftware.InnoSetup"
}

Say "done"
foreach ($f in @("dist_installer\SeansFontPrototypingFriend-Setup.exe",
                 "dist\SeansFontPrototypingFriend.zip",
                 "dist_single\SeansFontPrototypingFriend-SingleFile.exe")) {
    if (Test-Path $f) {
        Write-Host ("  {0,-58} {1,6:N1} MB" -f $f, ((Get-Item $f).Length / 1MB))
    }
}
