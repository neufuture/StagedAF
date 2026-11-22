"""Draws the UnitStager logo with the name next to it (and stacked), as SVG
with the lettering converted to outlines, so it looks the same everywhere
without the font installed. Uses Inter ExtraBold (SIL Open Font License).

    pip install fonttools
    python scripts/make-lockup.py [path/to/Inter-ExtraBold.otf]

PNG versions are rendered from these by scripts/make-lockup-png.mjs.
"""
import os
import re
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
FONT = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf'
INDIGO, INK, WHITE, SOFT = '#4F46E5', '#16171A', '#FFFFFF', '#C7C4FF'

font = TTFont(FONT)
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
upm = font['head'].unitsPerEm
cap = font['OS/2'].sCapHeight or 0.727 * upm


def text_path(text, size, x, baseline, tracking=-0.01):
    """SVG path data for text at font size `size`, starting at x on `baseline`."""
    scale = size / upm
    pen = SVGPathPen(glyphs)
    for ch in text:
        name = cmap[ord(ch)]
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        x += glyphs[name].width * scale + tracking * size
    return pen.getCommands(), x


def width(text, size, tracking=-0.01):
    return sum(glyphs[cmap[ord(c)]].width * size / upm + tracking * size for c in text)


# The icon's artwork, as drawn by scripts/make-icons.mjs (128 x 128).
icon_svg = open(os.path.join(ROOT, 'brand', 'unitstager-icon.svg')).read()
icon_inner = re.sub(r'^<svg[^>]*>|</svg>\s*$', '', icon_svg.strip())


def icon(x, y, s, white_tile=False):
    inner = icon_inner
    if white_tile:  # white tile, indigo artwork: for indigo or photo backgrounds
        inner = inner.replace(INDIGO, '#__I__').replace(WHITE, INDIGO).replace('#__I__', WHITE)
        inner = inner.replace('#ffffff', INDIGO).replace('#4f46e5', WHITE)
    return f'<g transform="translate({x:.2f} {y:.2f}) scale({s / 128:.5f})">{inner}</g>'


def horizontal(unit, stager, white_tile=False, pad=0):
    H = 128.0
    size = H * 0.62
    gap = H * 0.26
    tx = H + gap
    baseline = H / 2 + cap * size / upm / 2
    p1, x = text_path('Unit', size, pad + tx, pad + baseline)
    p2, x = text_path('Stager', size, x, pad + baseline)
    w = x + pad
    return w, H + 2 * pad, (f'{icon(pad, pad, H, white_tile)}<path fill="{unit}" d="{p1}"/><path fill="{stager}" d="{p2}"/>')


def stacked(unit, stager, white_tile=False):
    size = 128 * 0.42
    total = width('UnitStager', size)
    W = max(total, 128.0) + 8
    H_icon = 128.0
    gap = 26
    baseline = H_icon + gap + cap * size / upm
    p1, x = text_path('Unit', size, (W - total) / 2, baseline)
    p2, _ = text_path('Stager', size, x, baseline)
    descent = -font['hhea'].descent * size / upm
    return W, baseline + descent + 4, (f'{icon((W - H_icon) / 2, 0, H_icon, white_tile)}<path fill="{unit}" d="{p1}"/><path fill="{stager}" d="{p2}"/>')


def write(name, w, h, body):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.2f} {h:.2f}" width="{w:.0f}" height="{h:.0f}">{body}</svg>\n'
    open(os.path.join(ROOT, 'brand', name), 'w').write(svg)
    print('brand/' + name, f'{w:.0f}x{h:.0f}')


write('unitstager-logo.svg', *horizontal(INK, INDIGO))                    # light backgrounds
write('unitstager-logo-on-dark.svg', *horizontal(WHITE, SOFT))            # dark backgrounds
write('unitstager-logo-white.svg', *horizontal(WHITE, WHITE, True))       # on brand indigo or photos
write('unitstager-logo-stacked.svg', *stacked(INK, INDIGO))               # square spaces, light
write('unitstager-logo-stacked-on-dark.svg', *stacked(WHITE, SOFT))       # square spaces, dark
