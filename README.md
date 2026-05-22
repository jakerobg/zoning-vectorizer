# Zoning Vectorizer

A raster map vectorizer with added interactive color-pallete classification, built specifically for color-coded georeferenced zoning maps, or any solid-color-coded map.

(GeoTIFF) -> GeoJSON of district polygons.

**Everything runs locally in the browser, and masks are traced using d3contour.**

## How to use it

1. **Drag a georeferenced GeoTIFF onto the page.**
2. **Click each district color in the legend** (or on a clean district area in the map). Each color appears on the side.
3. **Type the district abbreviation** (e.g. `R-1`, `C-2`) into the input next to each swatch.
4. **Option/Alt-click on non-district colors** like roads, text, or parcel lines. These are excluded clusters and get filtered out.
5. **Click "Run digitize"** → open the GeoJSON in QGIS, Arc, etc.

---

## Steps

- The georeferened TIF is read in the browser.
- Each pixel is matched to the nearest palette color you picked using LAB color space
- Binary masks are created and cleaned (removes specks, fills small holes).
- Each mask is traced into polygons, then converted from pixels to real-world coordinates using the TIF's CRS and packaged as a geoJSON.

---

## Settings

| Setting          | What it does                                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **min-area**     | Drop polygons smaller than this (in CRS units — m² for EPSG:3857). Filters out noise.                                                                             |
| **patch (px ±)** | Each click averages a window of this size around the cursor, so anti-aliased edges don't throw off the picked color.                                              |
| **morph radius** | Smooths each color mask. Bump to 3-4 if roads or text are bleeding into districts. 0 disables.                                                                    |
| **shrink**       | Extra inward buffer after morphology. Helpful for parcel attribute joins — slightly smaller polygons avoid bleeding onto adjacent parcels. 1-2 is usually enough. |
