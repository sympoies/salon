# Salon icon

The Salon mark follows concept B: three folded ribbon bands form an S-shaped conversation mark. A dark teal upper band and lower band frame the light mint diagonal fold. A subtle fold highlight keeps the three main bands distinct at small sizes.

## Assets

- `../../assets/brand/salon-mark-light.svg` — vector mark for light surfaces.
- `../../assets/brand/salon-mark-dark.svg` — higher contrast colors for dark surfaces.
- `../../assets/brand/previews/` — transparent PNG previews rendered directly from each SVG at 16 × 16, 32 × 32, and 256 × 256 pixels.

The SVG files are the editable source. Preview PNG files are raster outputs and must be regenerated from the corresponding SVG when it changes. The mark contains no embedded raster artwork or provider logo.

## Inspection

Both SVG variants were rendered at their stated preview dimensions with `rsvg-convert`. The resulting PNG dimensions were checked with `identify`, and the 16 px, 32 px, and 256 px outputs were inspected at native size and enlarged with nearest-neighbor scaling for edge and silhouette review. The dark upper and lower bands remain distinct from the mint fold in each theme variant.

The layered bands keep the diagonal mint fold visible at 16 px. Each theme uses a distinct SVG title ID so both variants can be inlined in the same document without ID collisions.

## Validation note

This is original vector asset authoring and does not add executable product behavior. There is no meaningful failing-behavior test for this milestone. Validation uses the actual rendered dimensions, pixel inspection at native and enlarged sizes, contrast review against light and dark surfaces, and the repository pre-PR gate.
