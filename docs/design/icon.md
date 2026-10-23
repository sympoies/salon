# Salon icon

The Salon mark uses concept B: a continuous S-shaped conversation ribbon with two turns. Its two-part teal and mint gradient keeps the shape readable on light and dark surfaces.

## Assets

- `../../assets/brand/salon-mark-light.svg` — vector mark for light surfaces.
- `../../assets/brand/salon-mark-dark.svg` — higher contrast colors for dark surfaces.
- `../../assets/brand/previews/` — transparent PNG previews rendered directly from each SVG at 16 × 16 and 32 × 32 pixels.

The SVG files are the editable source. Preview PNG files are raster outputs and must be regenerated from the corresponding SVG when it changes. The mark contains no embedded raster artwork or provider logo.

## Inspection

Both SVG variants were rendered at their stated preview dimensions with `rsvg-convert`. The resulting PNG dimensions were checked with `identify`, and the 16 px and 32 px outputs were inspected at native size and enlarged with nearest-neighbor scaling for edge and silhouette review. The darker first turn and lighter second turn remain distinct in each theme variant.

## Validation note

This is original vector asset authoring and does not add executable product behavior. There is no meaningful failing-behavior test for this milestone. Validation uses the actual rendered dimensions, pixel inspection at native and enlarged sizes, contrast review against light and dark surfaces, and the repository pre-PR gate.
