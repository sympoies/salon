# Salon icon

The Salon mark uses concept B: a continuous S-shaped conversation ribbon with two turns. Its two-part teal and mint gradient keeps the shape readable on light and dark surfaces.

## Assets

- `../../assets/brand/salon-mark-light.svg` — vector mark for light surfaces.
- `../../assets/brand/salon-mark-dark.svg` — higher contrast colors for dark surfaces.
- `../../assets/brand/previews/` — transparent PNG previews rendered directly from each SVG at 16 × 16, 32 × 32, and 256 × 256 pixels.

The SVG files are the editable source. Preview PNG files are raster outputs and must be regenerated from the corresponding SVG when it changes. The mark contains no embedded raster artwork or provider logo.

## Inspection

Both SVG variants were rendered at 16 px, 32 px, and 256 px with `rsvg-convert`. The 256 px renders were cross-checked in headless Chrome and inspected on light and dark surfaces. The upper bridge cap now meets the lobe without an open notch. The 16 px and 32 px outputs were inspected at native size and enlarged with nearest-neighbor scaling. The darker first turn and lighter second turn remain distinct in each theme variant.

The widened waist keeps the two turns visibly connected at 16 px. The upper bridge cap overlaps the ribbon lobe to avoid a notch at larger sizes. Each theme uses distinct SVG title and gradient IDs so both variants can be inlined in the same document without ID collisions.

## Validation note

This is original vector asset authoring and does not add executable product behavior. There is no meaningful failing-behavior test for this milestone. Validation uses the actual rendered dimensions, pixel inspection at native and enlarged sizes, contrast review against light and dark surfaces, and the repository pre-PR gate.
