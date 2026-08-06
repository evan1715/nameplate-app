# verify_corel_order.ps1 — does CorelDRAW honour the cutting order and layers?
#
#   powershell -ExecutionPolicy Bypass -File verify_corel_order.ps1
#
# The part is held by the sheet until its outline is cut, so the outline must be
# the LAST thing cut and the engraving the first. Cut order comes from stacking
# order, bottom first. This checks what CorelDRAW actually ends up with:
#
#   * engrave (red) sits at the BOTTOM of the stack  -> cut first
#   * the outline (black) sits at the TOP            -> cut last
#   * each name is its own group (SVG) / layer (PDF)
#
# Needs CorelDRAW installed and signed in.

$ErrorActionPreference = "Continue"
$dir = "C:\Users\Zack\AppData\Local\Temp\corel_test"
$fails = 0
function Check($n, $ok, $d) {
    if ($ok) { Write-Host "[PASS] $n" -ForegroundColor Green }
    else { Write-Host "[FAIL] $n" -ForegroundColor Red; $script:fails++ }
    if ($d) { Write-Host "       $d" }
}
function IsRed($sh) {
    try { $c = $sh.Outline.Color; return ($c.RGBRed -gt 200 -and $c.RGBGreen -lt 80) }
    catch { return $false }
}
# flatten groups, keeping document stacking order
function Flatten($shapes, $acc) {
    foreach ($sh in $shapes) {
        $t = 0; try { $t = $sh.Type } catch {}
        if ($t -eq 7) { Flatten $sh.Shapes $acc; continue }
        [void]$acc.Add($sh)
    }
}

$app = $null
try {
    $app = New-Object -ComObject CorelDRAW.Application.24
    $app.Visible = $true
    Write-Host "CorelDRAW $($app.VersionMajor).$($app.VersionMinor)`n"

    foreach ($which in @("sheet_leadin.svg", "sheet_leadin.pdf")) {
        $file = Join-Path $dir $which
        Write-Host "=== $which ============================================"
        $doc = $app.OpenDocument($file)
        Start-Sleep -Milliseconds 1500
        $doc.Unit = 1
        $page = $doc.ActivePage

        # ---- grouping / layers ------------------------------------------ #
        if ($which -like "*.svg") {
            $names = @()
            foreach ($sh in $page.Shapes) {
                try { if ($sh.Type -eq 7 -and $sh.Name) { $names += $sh.Name } } catch {}
            }
            Check "$which : each name arrives as its own group" `
                  (($names -contains "ADAM") -and ($names -contains "OLIVIA")) `
                  "top-level groups: $($names -join ', ')"
        } else {
            $layers = @()
            foreach ($ly in $doc.Pages.Item(1).Layers) { $layers += $ly.Name }
            Check "$which : each name arrives as its own LAYER" `
                  (($layers -join ' ') -match "ADAM" -and ($layers -join ' ') -match "OLIVIA") `
                  "layers: $($layers -join ', ')"
        }

        # ---- stacking order = cut order --------------------------------- #
        $flat = New-Object System.Collections.ArrayList
        Flatten $page.Shapes $flat
        if ($flat.Count -lt 2) {
            Check "$which : shapes found" $false "only $($flat.Count)"
            $doc.Close(); continue
        }
        # Corel's Shapes collection is front-to-back: index 1 is the TOP object.
        $topIsBlack = -not (IsRed $flat[0])
        $botIsRed = IsRed $flat[$flat.Count - 1]
        # where does the first red appear, and the last black?
        $firstRed = -1; $lastBlack = -1
        for ($i = 0; $i -lt $flat.Count; $i++) {
            if ((IsRed $flat[$i]) -and $firstRed -lt 0) { $firstRed = $i }
            if (-not (IsRed $flat[$i])) { $lastBlack = $i }
        }
        Write-Host "       $($flat.Count) shapes; index 0 = TOP of stack = cut LAST"
        Write-Host "       top is black(cut)=$topIsBlack, bottom is red(engrave)=$botIsRed"
        Write-Host "       first red at index $firstRed, last black at index $lastBlack"

        Check "$which : engraving is at the bottom of the stack (cut FIRST)" `
              $botIsRed "bottom-most shape is red: $botIsRed"
        Check "$which : a cut is at the top of the stack (cut LAST)" `
              $topIsBlack "top-most shape is black: $topIsBlack"

        # Ordering is PER NAME, not global: each name is a separate part, so the
        # correct sequence is name1 engrave/inner/outline, then name2, and so on.
        # Within one name, every red must sit below every black.
        # SVG groups the names; PDF layers them. Collect whichever this file uses.
        $containers = @()
        foreach ($sh in $page.Shapes) {
            $t = 0; try { $t = $sh.Type } catch {}
            if ($t -eq 7) { $containers += @{ name = $sh.Name; shapes = $sh.Shapes } }
        }
        if ($containers.Count -eq 0) {
            foreach ($ly in $doc.Pages.Item(1).Layers) {
                if ($ly.Name -eq "Guides") { continue }
                try { if ($ly.Shapes.Count -gt 0) { $containers += @{ name = $ly.Name; shapes = $ly.Shapes } } } catch {}
            }
        }
        $perName = @()
        $bad = 0
        foreach ($cont in $containers) {
            $inner = New-Object System.Collections.ArrayList
            Flatten $cont.shapes $inner
            if ($inner.Count -lt 2) { continue }
            $fr = -1; $lb = -1
            for ($i = 0; $i -lt $inner.Count; $i++) {
                if ((IsRed $inner[$i]) -and $fr -lt 0) { $fr = $i }
                if (-not (IsRed $inner[$i])) { $lb = $i }
            }
            $nm = $cont.name
            $okName = ($fr -lt 0) -or ($fr -gt $lb)
            if (-not $okName) { $bad++ }
            $perName += "$nm[$($inner.Count) shapes: firstRed=$fr lastBlack=$lb ok=$okName]"
        }
        Check "$which : within each name, engrave is below every cut" `
              ($bad -eq 0 -and $perName.Count -ge 1) `
              ($perName -join '  ')

        $doc.Close()
        Start-Sleep -Milliseconds 500
    }
} catch {
    Check "CorelDRAW automation" $false "$($_.Exception.Message)"
} finally {
    if ($app) { try { $app.Quit() } catch {} }
}

Write-Host "`n=========================================================="
if ($fails -eq 0) { Write-Host "CorelDRAW honours the cutting order" -ForegroundColor Green; exit 0 }
else { Write-Host "$fails check(s) FAILED" -ForegroundColor Red; exit 1 }
