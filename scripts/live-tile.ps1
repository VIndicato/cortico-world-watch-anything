param(
    [int]$Seconds = 60,
    [int]$Frames = 6,
    [int]$Columns = 2,
    [int]$Pages = 1,
    [int]$Cell = 640,
    [string]$Out = "",
    [switch]$Loop,
    [switch]$Notify,
    [string]$LiveDir = "",
    [int]$OwnerPid = 0
)

# 陪看：每 $interval 秒截一屏，攒够 $Seconds 秒，按每页 $Frames 格拼成 $Pages 张带钟点时间码的宫格，
# 一次推进上下文。默认 60 秒 / 30 帧 / 2 秒一帧 / 5 页 × 6 格。
# -Loop 常驻：一直循环；不常驻只出一批。

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 目录由调用方给（插件传 <dataDir>\video\live）；单独手跑时落到临时目录。
if (-not $LiveDir) { $LiveDir = Join-Path ([IO.Path]::GetTempPath()) 'cortico-video-live' }
$liveDir = $LiveDir
$framesDir = Join-Path $liveDir 'frames'
New-Item -ItemType Directory -Force -Path $liveDir | Out-Null
New-Item -ItemType Directory -Force -Path $framesDir | Out-Null

if (-not $Out) { $Out = Join-Path $liveDir 'live-latest.png' }

$stateFile = Join-Path $liveDir 'last-tile.txt'
$logFile   = Join-Path $liveDir 'live-log.txt'
$pidFile   = Join-Path $liveDir 'live.pid'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Log([string]$msg) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    [IO.File]::AppendAllText($logFile, $line + "`r`n", $utf8NoBom)
}

# 出了一批就往 spool 目录里丢一张纸条，插件那边轮询到就推给会话（2026-11-15 从 live-push.mjs 换过来）。
function Write-Spool([string]$from, [string]$to, [string[]]$files) {
    $spool = Join-Path $liveDir 'spool'
    New-Item -ItemType Directory -Force -Path $spool | Out-Null
    $now = Get-Date
    $id = 'b' + $now.ToString('yyyyMMddHHmmssfff')
    $obj = [ordered]@{ id = $id; ts = $now.ToString('o'); from = $from; to = $to; files = @($files) }
    [IO.File]::WriteAllText((Join-Path $spool ($id + '.json')), ($obj | ConvertTo-Json -Compress -Depth 4), $utf8NoBom)
}

# 把一批帧拼成一张宫格；$files 是帧文件，$labels 是对应钟点。
function Draw-Tile([string[]]$files, [string[]]$labels, [string]$outPath, [int]$cols) {
    $cw = [Math]::Max(160, $Cell)
    $ch = [int]($cw * 9 / 16)
    $n = $files.Count
    $c = [Math]::Max(1, $cols)
    $rows = [int][Math]::Ceiling($n / $c)
    $bar = [Math]::Max(16, [int]($cw * 0.05))
    $canvas = New-Object System.Drawing.Bitmap ($c * $cw), ($rows * ($ch + $bar))
    $gg = [System.Drawing.Graphics]::FromImage($canvas)
    $gg.Clear([System.Drawing.Color]::Black)
    $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $font = New-Object System.Drawing.Font('Consolas', 16, [System.Drawing.FontStyle]::Bold)
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 235, 120))
    for ($k = 0; $k -lt $n; $k++) {
        $x = ($k % $c) * $cw
        $y = [int][Math]::Floor($k / $c) * ($ch + $bar)
        $img = [System.Drawing.Image]::FromFile((Resolve-Path $files[$k]).Path)
        $gg.DrawImage($img, (New-Object System.Drawing.Rectangle $x, $y, $cw, $ch))
        $img.Dispose()
        # 钟点画在画面下面单开的一条里，不压图（2026-11-15 他说标挡住了画面）
        $gg.DrawString($labels[$k], $font, $brush, $x + 6, $y + $ch + 2)
    }
    $gg.Dispose()
    $canvas.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $canvas.Dispose()
}

function Take-Batch {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $total = [Math]::Max(1, $Frames) * [Math]::Max(1, $Pages)
    $interval = [Math]::Max(1, [int][Math]::Round($Seconds / $total))

    Get-ChildItem $framesDir -Filter 'f*.png' -ErrorAction SilentlyContinue | Remove-Item -Force

    $stamps = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $total; $i++) {
        [void]$stamps.Add((Get-Date))
        $bmp = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.CopyFromScreen($screen.X, $screen.Y, 0, 0, $bmp.Size)
        } catch {
            $g.Dispose(); $bmp.Dispose()
            throw
        }
        $g.Dispose()
        $bmp.Save((Join-Path $framesDir ('f{0:D3}.png' -f $i)), [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        if ($i -lt $total - 1) { Start-Sleep -Seconds $interval }
    }

    $all = Get-ChildItem $framesDir -Filter 'f*.png' | Sort-Object Name
    $paths = @()
    $dir = Split-Path $Out
    $base = [IO.Path]::GetFileNameWithoutExtension($Out)
    for ($p = 0; $p -lt $Pages; $p++) {
        $slice = $all[($p * $Frames)..([Math]::Min(($p + 1) * $Frames - 1, $all.Count - 1))]
        $labs = @()
        foreach ($s in $slice) { $labs += $stamps[[int]([IO.Path]::GetFileNameWithoutExtension($s.Name).Substring(1))].ToString('HH:mm:ss') }
        $pagePath = if ($Pages -eq 1) { $Out } else { Join-Path $dir ('{0}-{1}.png' -f $base, ($p + 1)) }
        Draw-Tile ($slice | ForEach-Object { $_.FullName }) $labs $pagePath ([Math]::Max(1, $Columns))
        $paths += $pagePath
    }
    Get-ChildItem $framesDir -Filter 'f*.png' | Remove-Item -Force

    $from = $stamps[0].ToString('HH:mm:ss')
    $to = $stamps[$stamps.Count - 1].ToString('HH:mm:ss')
    $size = [Math]::Round((($paths | ForEach-Object { (Get-Item $_).Length }) | Measure-Object -Sum).Sum / 1KB)
    [IO.File]::WriteAllText($stateFile, "$from -> $to · $total 帧 / $($Pages) 张 × $($Frames) 格 · ${size}KB", $utf8NoBom)
    if ($Notify) { Write-Spool $from $to $paths }
    return "$from -> $to  $($paths.Count) 张  共 ${size}KB"
}

if ($Loop) {
    [IO.File]::WriteAllText($pidFile, "$PID", $utf8NoBom)
    Write-Log "常驻开始 pid=$PID（归属进程 $OwnerPid）：每 $Seconds 秒 $($Frames * $Pages) 帧，$Pages 张 × $Frames 格 → $Out"
    try {
        while ($true) {
            # 归属进程没了就自己退：这条路是 WMI 起的，父进程退出不会带走我们（2026-11-20）
            if ($OwnerPid -gt 0 -and -not (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue)) {
                Write-Log "归属进程 $OwnerPid 已退出，常驻结束"
                break
            }
            try {
                $r = Take-Batch
                Write-Log $r
            } catch {
                Write-Log ('出错：' + $_.Exception.Message)
                Start-Sleep -Seconds 3
            }
        }
    } finally {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
} else {
    $r = Take-Batch
    Write-Log $r
    $r
}
