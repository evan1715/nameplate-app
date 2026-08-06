# verify_corel.ps1 — open our output in the real CorelDRAW and inspect it.
#
#   powershell -ExecutionPolicy Bypass -File verify_corel.ps1
#
# CorelDRAW must be installed, licensed and SIGNED IN — until you have signed in
# it never registers its automation object and this script cannot talk to it.
#
# Answers, with evidence rather than documentation:
#   1. is the artwork the exact physical size the app reported?
#   2. does CorelDRAW keep each lead-in path OPEN, or silently close it?
#   3. is the lead-in part of the contour (one long open path), or a stray stub?
#   4. do those paths still START at the pierce point out in the scrap?
#   5. are CUT and ENGRAVE still separable, and still hairline with no fill?
#
# Opens copies in new documents and closes them without saving.

$ErrorActionPreference = "Continue"
$dir = "C:\Users\Zack\AppData\Local\Temp\corel_test"
$exp = Get-Content (Join-Path $dir "expected.json") -Raw | ConvertFrom-Json
$fails = 0
function Check($n, $ok, $d) {
    if ($ok) { Write-Host "[PASS] $n" -ForegroundColor Green }
    else { Write-Host "[FAIL] $n" -ForegroundColor Red; $script:fails++ }
    if ($d) { Write-Host "       $d" }
}

# every curve on the page, groups flattened
function Get-Curves($shapes, $acc) {
    foreach ($sh in $shapes) {
        $t = 0; try { $t = $sh.Type } catch {}
        if ($t -eq 7) {                       # cdrGroupShape
            try { Get-Curves $sh.Shapes $acc } catch {}
            continue
        }
        $crv = $null; try { $crv = $sh.Curve } catch {}
        if ($crv) { [void]$acc.Add(@{ shape = $sh; curve = $crv }) }
    }
}

Write-Host "app reported: $([math]::Round($exp.width_in,4)) x $([math]::Round($exp.height_in,4)) in, $($exp.n_contours) contours, $($exp.n_runs) lead-in runs"

$app = $null
try {
    $app = New-Object -ComObject CorelDRAW.Application.24
    $app.Visible = $true
    Write-Host "CorelDRAW $($app.VersionMajor).$($app.VersionMinor) reached via automation`n"

    foreach ($which in @("ADAM_leadin.svg", "ADAM_leadin.pdf", "ADAM_plain.svg")) {
        $file = Join-Path $dir $which
        Write-Host "=== $which ==============================================="
        $doc = $app.OpenDocument($file)
        Start-Sleep -Milliseconds 1200
        $doc.Unit = 1                          # inches
        $page = $doc.ActivePage

        # ---- 1. exact size ---------------------------------------------- #
        $all = $page.Shapes.All()
        $W = $all.SizeWidth; $H = $all.SizeHeight
        Check "$which : imports at the exact size the app reported" `
              ([Math]::Abs($W - $exp.width_in) -lt 0.002 -and `
               [Math]::Abs($H - $exp.height_in) -lt 0.002) `
              ("CorelDRAW measures {0:N4} x {1:N4} in; app said {2:N4} x {3:N4} in" -f `
               $W, $H, $exp.width_in, $exp.height_in)
        $left = $all.LeftX; $bottom = $all.BottomY

        # ---- walk every curve ------------------------------------------- #
        $curves = New-Object System.Collections.ArrayList
        Get-Curves $page.Shapes $curves
        $open = 0; $closed = 0; $starts = @(); $maxNodes = 0
        $blackOpen = 0
        foreach ($c in $curves) {
            $crv = $c.curve
            $isRed = $false
            try {
                $ol = $c.shape.Outline
                if ($ol -and $ol.Color) { $isRed = ($ol.Color.RGBRed -gt 200 -and $ol.Color.RGBGreen -lt 80) }
            } catch {}
            for ($i = 1; $i -le $crv.SubPaths.Count; $i++) {
                $sp = $crv.SubPaths.Item($i)
                $n = $sp.Nodes.Count
                if ($n -gt $maxNodes) { $maxNodes = $n }
                if ($sp.Closed) { $closed++ }
                else {
                    $open++
                    if (-not $isRed) { $blackOpen++ }
                    $sn = $sp.StartNode
                    $starts += @{ x = $sn.PositionX; y = $sn.PositionY; n = $n; red = $isRed }
                }
            }
        }
        Write-Host "       curves=$($curves.Count) subpaths: $open open / $closed closed; largest node count=$maxNodes"

        if ($which -like "*plain*") {
            # the control: with no lead-ins the outline should be CLOSED
            Check "$which : without lead-ins the outline stays closed" `
                  ($closed -ge 1) "$closed closed subpath(s) - the control case"
        } else {
            Check "$which : CorelDRAW keeps the lead-in paths OPEN" `
                  ($blackOpen -ge $exp.n_runs) `
                  "$blackOpen open black subpath(s); expected at least $($exp.n_runs)"

            $long = ($starts | Where-Object { -not $_.red -and $_.n -gt 20 }).Count
            Check "$which : lead-ins are merged INTO the contour, not stray stubs" `
                  ($long -ge 1) `
                  "$long open black subpath(s) carry >20 nodes (a stray stub would be 2)"

            # ---- 4. do paths start at our pierce points? ---------------- #
            $matched = 0; $detail = @()
            foreach ($p in $exp.pierces_in) {
                $fx = $p.x_in / $exp.width_in
                $fyTop = $p.y_in / $exp.height_in
                $best = 99.0
                foreach ($s in $starts) {
                    if ($s.red) { continue }
                    $gx = ($s.x - $left) / $exp.width_in
                    $gyTop = 1.0 - (($s.y - $bottom) / $exp.height_in)
                    $d = [Math]::Sqrt([Math]::Pow($gx - $fx, 2) + [Math]::Pow($gyTop - $fyTop, 2))
                    if ($d -lt $best) { $best = $d }
                }
                if ($best -lt 0.02) { $matched++ }
                $detail += ("{0:N3}" -f $best)
            }
            Check "$which : path start nodes land on our pierce points" `
                  ($matched -eq $exp.n_runs) `
                  "$matched of $($exp.n_runs) matched; nearest-start distances (fraction of width): $($detail -join ', ')"
        }

        # ---- 5. CUT / ENGRAVE still distinguishable and unfilled -------- #
        $reds = 0; $filled = 0; $hair = 0
        foreach ($c in $curves) {
            try {
                $ol = $c.shape.Outline
                if ($ol -and $ol.Color -and $ol.Color.RGBRed -gt 200 -and $ol.Color.RGBGreen -lt 80) { $reds++ }
                if ($ol -and $ol.Width -le 0.0015) { $hair++ }
            } catch {}
            try { if ($c.shape.Fill.Type -ne 0) { $filled++ } } catch {}
        }
        $groupNames = @()
        foreach ($sh in $page.Shapes) { try { if ($sh.Type -eq 7 -and $sh.Name) { $groupNames += $sh.Name } } catch {} }
        # Only SVG can carry group NAMES. PDF has no named-group concept, so
        # CorelDRAW imports unnamed shapes — the colours still separate CUT from
        # ENGRAVE, but you cannot select by name. That is a property of PDF, not
        # a defect, so it is only required of the SVG.
        if ($which -like "*.svg") {
            Check "$which : CUT and ENGRAVE arrive as separately named groups" `
                  (($groupNames -contains "CUT") -and ($groupNames -contains "ENGRAVE")) `
                  "groups found: $($groupNames -join ', ')"
        } else {
            Write-Host "       note: PDF carries no group names (found: '$($groupNames -join ', ')') - use the SVG if you want to select CUT/ENGRAVE by name"
        }

        Check "$which : engrave curves still red, nothing filled" `
              ($reds -ge 1 -and $filled -eq 0) `
              "$reds red curve(s), $filled filled shape(s), $hair hairline-or-finer outline(s) of $($curves.Count)"

        $doc.Close()
        Start-Sleep -Milliseconds 500
    }
} catch {
    Check "CorelDRAW automation" $false "$($_.Exception.Message)"
} finally {
    if ($app) { try { $app.Quit() } catch {} }
}

Write-Host "`n=========================================================="
if ($fails -eq 0) { Write-Host "CorelDRAW reads the files as intended" -ForegroundColor Green; exit 0 }
else { Write-Host "$fails check(s) FAILED in CorelDRAW" -ForegroundColor Red; exit 1 }
