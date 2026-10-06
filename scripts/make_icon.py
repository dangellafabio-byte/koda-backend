"""
Genera l'icona Ollenya 1024×1024 PNG opaco (ricostruzione v2).
"""
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
NAVY = (10, 8, 32)
cx, cy = SIZE // 2, SIZE // 2

base = Image.new("RGBA", (SIZE, SIZE), NAVY + (255,))

# Aurora outer
aura_outer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(aura_outer).ellipse(
    [cx - 380, cy - 380, cx + 380, cy + 380], fill=(0, 229, 209, 110),
)
aura_outer = aura_outer.filter(ImageFilter.GaussianBlur(radius=100))

# Aurora mid
aura_mid = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(aura_mid).ellipse(
    [cx - 340, cy - 340, cx + 340, cy + 340], fill=(0, 229, 209, 170),
)
aura_mid = aura_mid.filter(ImageFilter.GaussianBlur(radius=55))

# Aurora rim
aura_rim = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(aura_rim).ellipse(
    [cx - 300, cy - 300, cx + 300, cy + 300], fill=(80, 255, 230, 220),
)
aura_rim = aura_rim.filter(ImageFilter.GaussianBlur(radius=25))

base = Image.alpha_composite(base, aura_outer)
base = Image.alpha_composite(base, aura_mid)
base = Image.alpha_composite(base, aura_rim)

# Eclipse
ECLIPSE_R = 280
eclipse = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(eclipse).ellipse(
    [cx - ECLIPSE_R, cy - ECLIPSE_R, cx + ECLIPSE_R, cy + ECLIPSE_R],
    fill=(0, 0, 0, 255),
)
inner = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(inner).ellipse(
    [cx - ECLIPSE_R + 50, cy - ECLIPSE_R + 50, cx + ECLIPSE_R - 50, cy + ECLIPSE_R - 50],
    fill=(12, 10, 40, 90),
)
inner = inner.filter(ImageFilter.GaussianBlur(radius=30))
base = Image.alpha_composite(base, eclipse)
base = Image.alpha_composite(base, inner)

# Teal rounded border
INSET = 110
RRADIUS = 200
STROKE = 7

border_glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(border_glow).rounded_rectangle(
    [INSET, INSET, SIZE - INSET, SIZE - INSET],
    radius=RRADIUS, outline=(0, 229, 209, 200), width=STROKE + 14,
)
border_glow = border_glow.filter(ImageFilter.GaussianBlur(radius=14))

border = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(border).rounded_rectangle(
    [INSET, INSET, SIZE - INSET, SIZE - INSET],
    radius=RRADIUS, outline=(70, 240, 220, 255), width=STROKE,
)
base = Image.alpha_composite(base, border_glow)
base = Image.alpha_composite(base, border)

# Flatten RGB (no alpha)
final = Image.new("RGB", (SIZE, SIZE), NAVY)
final.paste(base, (0, 0), base)

out = "/app/frontend/assets/images/icon.png"
final.save(out, "PNG", optimize=True)

# Verify
with Image.open(out) as img:
    assert img.size == (1024, 1024)
    assert img.mode == "RGB"

import shutil, os
shutil.copyfile(out, "/app/frontend/assets/images/adaptive-icon.png")

print(f"OK: wrote {out} ({os.path.getsize(out)/1024:.1f} KB)")
print(f"OK: wrote /app/frontend/assets/images/adaptive-icon.png")
