"""Generate the PWA icons. Re-runnable; overwrites web/icon-*.png.

The maskable variant keeps all artwork inside the inner 80% safe zone, because
Android crops maskable icons to whatever shape the launcher uses.
"""
from PIL import Image, ImageDraw, ImageFont
import os

BLUE = (0, 32, 96)
RED = (200, 16, 46)
GREEN = (132, 189, 0)
WHITE = (255, 255, 255)
OUT = os.path.join(os.path.dirname(__file__), '..', 'web')


def font(size):
    for name in ('segoeuib.ttf', 'arialbd.ttf', 'DejaVuSans-Bold.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def centred(d, box, text, f, fill):
    x0, y0, x1, y1 = box
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    d.text((x0 + (x1 - x0 - (r - l)) / 2 - l,
            y0 + (y1 - y0 - (b - t)) / 2 - t), text, font=f, fill=fill)


def build(size, maskable=False):
    img = Image.new('RGB', (size, size), BLUE)
    d = ImageDraw.Draw(img)

    # Safe zone: maskable icons get cropped, so pull the artwork inwards.
    pad = size * 0.18 if maskable else size * 0.10
    inner = (pad, pad, size - pad, size - pad)
    w = inner[2] - inner[0]

    # "OY" wordmark
    centred(d, (inner[0], inner[1], inner[2], inner[1] + w * 0.62),
            'OY', font(int(w * 0.52)), WHITE)

    # A stock bar underneath: mostly green with a red damaged segment — the same
    # visual device the balance screen uses.
    bar_h = max(4, int(w * 0.13))
    by = inner[1] + w * 0.70
    d.rounded_rectangle([inner[0], by, inner[2], by + bar_h],
                        radius=bar_h // 2, fill=GREEN)
    split = inner[0] + w * 0.74
    d.rounded_rectangle([split, by, inner[2], by + bar_h],
                        radius=bar_h // 2, fill=RED)
    return img


for name, size, mask in (('icon-192.png', 192, False),
                         ('icon-512.png', 512, False),
                         ('icon-maskable.png', 512, True)):
    path = os.path.normpath(os.path.join(OUT, name))
    build(size, mask).save(path, 'PNG', optimize=True)
    print(f'{name}: {os.path.getsize(path)} bytes')
