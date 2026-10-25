# Salon icon

The Salon mark uses the maintainer-selected Continuous jade direction. A single
uninterrupted ribbon forms the S silhouette; a teal-to-mint gradient flows
through the center without separate stacked faces or overlap seams.

## Assets

- [Dark SVG](../../assets/brand/salon-mark-dark.svg) — the selected gradient for dark surfaces.
- [Light SVG](../../assets/brand/salon-mark-light.svg) — the same outline with deeper green stops for contrast on light surfaces.
- [Previews](../../assets/brand/previews/) — transparent PNGs at 16 × 16, 32 × 32 and 256 × 256 for both themes.
- [Before and after](../../assets/brand/previews/salon-mark-before-after.png) — both themes at 256px, with native-size and 4× small-size checks.

The two SVGs are the editable masters. Both use the same single path and round
returns; their title and gradient IDs are unique across themes. There is no
embedded raster art or provider logo. The workspace already serves these files
as theme-specific SVG favicons. This repository has no Salon native-platform
icon generator or additional Salon platform icon outputs.

## Rendering

Recorded tools: `image-processing 1.36.34`, Python 3.12, Pillow 10.2.0 and
DejaVu Sans 2.37. Run from the repository root. Validate before rendering;
all generated preview PNGs retain transparent backgrounds.

```bash
brand_scratch="$(mktemp -d)"
for theme in dark light; do
  image-processing svg-validate \
    --in "assets/brand/salon-mark-$theme.svg" \
    --out "$brand_scratch/$theme.svg" --json
  for size in 16 32 256; do
    image-processing convert --in "$brand_scratch/$theme.svg" --to png \
      --out "assets/brand/previews/salon-mark-$theme-$size.png" \
      --width "$size" --height "$size" --overwrite
  done
done
```

The comparison composites the original previews from the recorded base commit
and the newly rendered previews. Small-size enlargement uses nearest-neighbor
sampling; the native-size images are pasted without resizing.

```bash
python3 - <<'PY'
from pathlib import Path
from io import BytesIO
import subprocess
from PIL import Image, ImageDraw, ImageFont

base = "dd6b775fa7d72cb45e7bb14a3cd47a4213a92e44"
previews = Path("assets/brand/previews")
sheet = Image.new("RGB", (1200, 740), "#0d181e")
draw = ImageDraw.Draw(sheet)
def label(x, y, text, size=16, color="#b8cfc6", bold=False):
    font = ImageFont.truetype("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf", size)
    draw.text((x, y), text, font=font, fill=color)
label(30, 24, "SALON / Selected: Continuous jade", 28, "#e9f7ef", True)
label(30, 68, "Old to new  /  One uninterrupted ribbon  /  Native-size and enlarged checks")
for column, (theme, old) in enumerate([("dark", True), ("dark", False), ("light", True), ("light", False)]):
    x = 30 + column * 290
    bg = "#101e23" if theme == "dark" else "#f4f7f5"
    label(x, 102, ("Old" if old else "New") + " / " + theme, 20, "#e9f7ef", True)
    def load(size):
        name = f"salon-mark-{theme}-{size}.png"
        data = subprocess.check_output(["git", "show", f"{base}:assets/brand/previews/{name}"]) if old else (previews / name).read_bytes()
        image = Image.open(BytesIO(data)).convert("RGBA")
        assert image.size == (size, size)
        assert image.getpixel((0, 0))[3] == 0
        return image
    def paste(image, left, top):
        tile = Image.new("RGBA", image.size, bg)
        tile.alpha_composite(image)
        sheet.paste(tile.convert("RGB"), (left, top))
    paste(load(256), x, 140)
    label(x, 422, "32px / native + 4x")
    paste(load(32), x + 12, 492)
    paste(load(32).resize((128, 128), Image.Resampling.NEAREST), x + 100, 458)
    label(x, 612, "16px / native + 4x")
    paste(load(16), x + 20, 670)
    paste(load(16).resize((64, 64), Image.Resampling.NEAREST), x + 132, 648)
sheet.save(previews / "salon-mark-before-after.png")
print("Compared both themes at 256px, with native and 4x small-size checks.")
PY
```

## Inspection and validation

Both SVGs passed `image-processing svg-validate`. The six previews were checked
for exact dimensions and transparent corners, and inspected on dark and light
surfaces at native size and 4× enlargement. The S silhouette and its two open
returns remain legible at 16px and 32px. The new dark preview matches the
selected candidate's pixels when composited on the selection background.

Test-first waiver: static vector artwork has no executable product behavior.
No behavioral tests were added. Substitute checks cover SVG validation,
actual rendered dimensions, transparency, visual inspection and deterministic
regeneration, together with the repository pre-PR gate.
