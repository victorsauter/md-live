Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.Clear([System.Drawing.Color]::Transparent)
function RoundRect($x, $y, $w, $h, $r) { $p = New-Object System.Drawing.Drawing2D.GraphicsPath; $d = $r * 2; $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90); $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90); $p.CloseFigure(); return $p }
$bg = RoundRect 8 8 240 240 44
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point 256, 256), ([System.Drawing.Color]::FromArgb(255, 37, 99, 235)), ([System.Drawing.Color]::FromArgb(255, 124, 58, 237))
$g.FillPath($brush, $bg)
# Page
$page = RoundRect 52 40 152 176 16
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(245, 255, 255, 255))), $page)
# "M" with a down arrow (Markdown mark)
$ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 30, 41, 59))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 30, 41, 59)), 14
$pen.LineJoin = 'Round'; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
$g.DrawLines($pen, [System.Drawing.Point[]]@((New-Object System.Drawing.Point 76, 132), (New-Object System.Drawing.Point 76, 76), (New-Object System.Drawing.Point 102, 104), (New-Object System.Drawing.Point 128, 76), (New-Object System.Drawing.Point 128, 132)))
$g.DrawLine($pen, 160, 76, 160, 124)
$g.FillPolygon($ink, [System.Drawing.Point[]]@((New-Object System.Drawing.Point 142, 116), (New-Object System.Drawing.Point 178, 116), (New-Object System.Drawing.Point 160, 138)))
# Text lines, the first one with a caret (live editing)
$line = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 148, 163, 184))
$g.FillRectangle($line, 76, 160, 70, 10)
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 37, 99, 235))), 152, 154, 6, 22)
$g.FillRectangle($line, 76, 186, 104, 10)
$g.Dispose()
$out = New-Object System.Drawing.Bitmap 128, 128
$g2 = [System.Drawing.Graphics]::FromImage($out); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.SmoothingMode = 'AntiAlias'; $g2.PixelOffsetMode = 'HighQuality'
$g2.DrawImage($bmp, 0, 0, 128, 128); $g2.Dispose()
$out.Save((Join-Path $PWD 'media\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
'saved'
