// Static zoning map digitizer.
//
//   1) parse GeoTIFF (geotiff.js)    - RGB raster + pixel to world affine + CRS
//   2) user picks legend swatches    - palette of RGB and district names
//   3) assign each pixel to nearest  - per-pixel cluster id (LAB distance)
//      palette color in LAB space
//   4) for each cluster:             - per-cluster binary mask
//      d3.contours @ 0.5 threshold   - MultiPolygon in pixel coords
//      apply affine                  - Polygons in source CRS
//      filter by min area
//   5) write FeatureCollection       - trigger download as <stem>.geojson


const state = {
  name: null,
  width: 0, height: 0,
  rgb: null,            // Uint8ClampedArray length w*h*4 (canvas data)
  origin: [0, 0],       // world coords of pixel (0,0) corner
  resolution: [1, -1],  // world units per pixel in x, y
  crs: null,            // "EPSG:3857" or null if missing
  picks: [],            // [{hex, rgb:[r,g,b], label, x, y}]
};

const cv = document.getElementById("cv");
const ctx = cv.getContext("2d");
const drop = document.getElementById("drop");
const fileInput = document.getElementById("file");
const statusEl = document.getElementById("status");
const runBtn = document.getElementById("run");

// ---------- color: sRGB → LAB (D65) -----------------------------------------
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function rgbToLab(r, g, b) {
  r = srgbToLinear(r / 255);
  g = srgbToLinear(g / 255);
  b = srgbToLinear(b / 255);
  let x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  let y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  let z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
  x /= 0.95047; y /= 1.0; z /= 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const L = 116 * f(y) - 16;
  const A = 500 * (f(x) - f(y));
  const B = 200 * (f(y) - f(z));
  return [L, A, B];
}

// ---------- TIF loading ------------------------------------------------------
async function loadTif(file) {
  setStatus("parsing TIF…");
  const buf = await file.arrayBuffer();
  let tiff, image;
  try {
    tiff = await GeoTIFF.fromArrayBuffer(buf);
    image = await tiff.getImage();
  } catch (e) {
    alert("could not parse TIF: " + e.message);
    return;
  }
  const w = image.getWidth(), h = image.getHeight();
  if (w * h > 50_000_000) {
    if (!confirm(`image is ${w}x${h} (${(w*h/1e6).toFixed(1)} MP) — this may be slow. continue?`)) return;
  }

  // RGB raster (interleaved into a typed array)
  setStatus(`reading rasters ${w}×${h}…`);
  const interleaved = await image.readRasters({ interleave: true });
  const samples = image.getSamplesPerPixel();
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (samples >= 3) {
    for (let i = 0, j = 0; i < w * h; i++) {
      rgba[j++] = interleaved[i * samples];
      rgba[j++] = interleaved[i * samples + 1];
      rgba[j++] = interleaved[i * samples + 2];
      rgba[j++] = samples >= 4 ? interleaved[i * samples + 3] : 255;
    }
  } else if (samples === 1) {
    for (let i = 0, j = 0; i < w * h; i++) {
      const v = interleaved[i];
      rgba[j++] = v; rgba[j++] = v; rgba[j++] = v; rgba[j++] = 255;
    }
  } else {
    alert("unsupported sample count: " + samples);
    return;
  }

  // Georeferencing
  let origin = [0, 0], resolution = [1, -1], crs = null;
  try { origin = image.getOrigin(); } catch (e) {}
  try { resolution = image.getResolution(); } catch (e) {}
  try {
    const keys = image.getGeoKeys() || {};
    const code = keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey;
    if (code) crs = "EPSG:" + code;
  } catch (e) {}

  state.name = file.name;
  state.width = w; state.height = h; state.rgb = rgba;
  state.origin = [origin[0], origin[1]];
  state.resolution = [resolution[0], resolution[1]];
  state.crs = crs;
  state.picks = [];

  // Render to canvas
  cv.width = w; cv.height = h;
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  cv.style.maxHeight = (window.innerHeight - 30) + "px";
  cv.style.display = "";
  drop.style.display = "none";

  document.getElementById("filename").textContent = file.name;
  document.getElementById("crsInfo").textContent =
    (crs ? crs : "no CRS detected") + `  •  ${w}×${h}`;
  document.getElementById("reset").style.display = "inline-block";
  runBtn.disabled = false;
  renderPicks();
  setStatus(crs ? `loaded ${file.name}` : "warning: no CRS in TIF — output coords will be in pixel space");
}

function reset() {
  state.name = null; state.rgb = null; state.picks = [];
  cv.style.display = "none";
  drop.style.display = "flex";
  document.getElementById("filename").textContent = "no file loaded";
  document.getElementById("crsInfo").textContent = "";
  document.getElementById("reset").style.display = "none";
  runBtn.disabled = true;
  setStatus("");
  renderPicks();
}

// ---------- click → pick -----------------------------------------------------
cv.addEventListener("click", (e) => {
  if (!state.rgb) return;
  const rect = cv.getBoundingClientRect();
  const sx = state.width / rect.width, sy = state.height / rect.height;
  const x = Math.round((e.clientX - rect.left) * sx);
  const y = Math.round((e.clientY - rect.top) * sy);
  const patch = parseInt(document.getElementById("patch").value) || 0;
  const x0 = Math.max(0, x - patch), y0 = Math.max(0, y - patch);
  const x1 = Math.min(state.width, x + patch + 1), y1 = Math.min(state.height, y + patch + 1);
  let r = 0, g = 0, b = 0, n = 0;
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * state.width + px) * 4;
      r += state.rgb[i]; g += state.rgb[i + 1]; b += state.rgb[i + 2]; n++;
    }
  }
  r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
  const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  const excluded = e.altKey;  // option/alt-click → excluded
  state.picks.push({ hex, rgb: [r, g, b], label: "", skip: excluded, x, y });
  drawMarker(x, y, state.picks.length, patch, excluded);
  renderPicks();
});

function drawMarker(x, y, idx, patch, excluded) {
  const stroke = excluded ? "#d44" : "#000";
  ctx.strokeStyle = stroke; ctx.lineWidth = 2;
  ctx.strokeRect(x - patch - 1, y - patch - 1, 2 * patch + 3, 2 * patch + 3);
  ctx.fillStyle = "#fff"; ctx.fillRect(x + patch + 2, y - 7, 26, 14);
  ctx.fillStyle = stroke; ctx.font = "11px monospace";
  ctx.fillText((excluded ? "✕" : "") + idx, x + patch + 5, y + 3);
}

function redrawAllMarkers() {
  if (!state.rgb) return;
  ctx.putImageData(new ImageData(state.rgb, state.width, state.height), 0, 0);
  const patch = parseInt(document.getElementById("patch").value) || 0;
  state.picks.forEach((p, i) => drawMarker(p.x, p.y, i + 1, patch, p.skip));
}

function renderPicks() {
  const districts = document.getElementById("listDistricts");
  const excluded = document.getElementById("listExcluded");
  districts.innerHTML = "";
  excluded.innerHTML = "";
  let nD = 0, nE = 0;

  state.picks.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "pick" + (p.skip ? " excluded" : "");
    const placeholder = p.skip ? "label (e.g. road, text)" : "Abbreviated District Name";
    row.innerHTML = `
      <div class="swatch" style="background:${p.hex}"></div>
      <div class="meta">
        <div>${i + 1}. ${p.hex}</div>
        <input type="text" class="lbl" placeholder="${placeholder}" value="${p.label.replace(/"/g, "&quot;")}">
      </div>
      <button class="del" title="delete">×</button>`;
    row.querySelector(".lbl").addEventListener("input", (e) => { p.label = e.target.value; });
    row.querySelector(".del").addEventListener("click", () => {
      state.picks.splice(i, 1); renderPicks(); redrawAllMarkers();
    });
    if (p.skip) { excluded.appendChild(row); nE++; } else { districts.appendChild(row); nD++; }
  });

  document.getElementById("countDistricts").textContent = nD;
  document.getElementById("countExcluded").textContent = nE;
  if (nD === 0) districts.innerHTML = `<div class="section-desc" style="text-align:center;opacity:0.6">${state.name ? "click the map to add a district" : "load a tif to start"}</div>`;
  if (nE === 0) excluded.innerHTML  = `<div class="section-desc" style="text-align:center;opacity:0.6">option/alt-click on the map to add</div>`;
}

// ---------- digitize ---------------------------------------------------------
async function digitize() {
  if (!state.picks.length) { alert("pick at least one color"); return; }
  runBtn.disabled = true;
  const minArea = parseFloat(document.getElementById("minArea").value) || 0;
  const morphR = Math.max(0, parseInt(document.getElementById("morphR").value) || 0);
  const shrinkR = Math.max(0, parseInt(document.getElementById("shrinkR").value) || 0);
  const w = state.width, h = state.height;
  const N = w * h;

  setStatus("computing LAB palette…");
  await tick();
  const palLab = state.picks.map((p) => rgbToLab(...p.rgb));

  // Validity mask: drop near-white background and (if alpha present) zero alpha.
  setStatus("assigning pixels to nearest palette color…");
  await tick();
  const labels = new Int16Array(N);  // -1 = invalid, else cluster id
  const K = palLab.length;
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const r = state.rgb[p], g = state.rgb[p + 1], b = state.rgb[p + 2], a = state.rgb[p + 3];
    if (a === 0 || (r >= 245 && g >= 245 && b >= 245)) { labels[i] = -1; continue; }
    const [L, A, B] = rgbToLab(r, g, b);
    let best = 0, bestD = Infinity;
    for (let k = 0; k < K; k++) {
      const dL = L - palLab[k][0], dA = A - palLab[k][1], dB = B - palLab[k][2];
      const d = dL * dL + dA * dA + dB * dB;
      if (d < bestD) { bestD = d; best = k; }
    }
    labels[i] = best;
  }

  // For each cluster: binary mask → d3.contours → world polygons → features
  const features = [];
  const [ox, oy] = state.origin;
  const [rx, ry] = state.resolution;
  const px2world = (px, py) => [ox + px * rx, oy + py * ry];
  const pixelArea = Math.abs(rx * ry);  // for min-area filter

  for (let k = 0; k < K; k++) {
    if (state.picks[k].skip) {
      setStatus(`skipping cluster ${k + 1} / ${K} (${state.picks[k].hex}, marked skip)…`);
      await tick();
      continue;
    }
    setStatus(`polygonizing cluster ${k + 1} / ${K} (${state.picks[k].hex})…`);
    await tick();
    let mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = labels[i] === k ? 1 : 0;
    if (morphR > 0) {
      mask = binaryOpen(mask, w, h, morphR);   // remove specks
      mask = binaryClose(mask, w, h, morphR);  // fill small holes
    }
    if (shrinkR > 0) {
      mask = morphPass(mask, w, h, shrinkR, "erode");  // extra inward buffer
    }
    const contours = d3.contours().size([w, h]).thresholds([0.5])(mask);
    if (!contours.length) continue;
    const mp = contours[0];  // MultiPolygon at threshold 0.5

    for (const poly of mp.coordinates) {
      // poly = [outerRing, hole, hole, ...] in pixel coords
      const rings = poly.map((ring) => ring.map(([px, py]) => px2world(px, py)));
      const outerArea = Math.abs(ringArea(rings[0]));
      if (outerArea < minArea) continue;
      const props = {
        "Abbreviated District Name": state.picks[k].label || null,
        cluster_id: k,
        color_hex: state.picks[k].hex,
        area_m2: outerArea,
      };
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: rings },
        properties: props,
      });
    }
  }

  const fc = { type: "FeatureCollection", features };
  if (state.crs) fc.crs = { type: "name", properties: { name: state.crs } };

  const blob = new Blob([JSON.stringify(fc)], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (state.name.replace(/\.tiff?$/i, "") || "output") + ".geojson";
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`downloaded ${a.download}  •  ${features.length} features`);
  runBtn.disabled = false;
}

// ---------- binary morphology -----------------------------------------------
// open  = erode then dilate (removes specks smaller than the kernel)
// close = dilate then erode (fills holes smaller than the kernel)
// Both implemented as separable 1D passes for speed: O(W*H*r) per op.
function morphPass(mask, w, h, r, op) {
  // op: "erode" -> AND over window (any 0 → 0); "dilate" -> OR (any 1 → 1).
  const horizontal = new Uint8Array(mask.length);
  const test = op === "erode" ? 0 : 1;
  // horizontal
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = op === "erode" ? 1 : 0;
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let xi = x0; xi <= x1; xi++) {
        if (mask[row + xi] === test) { v = test; break; }
      }
      horizontal[row + x] = v;
    }
  }
  // vertical
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = op === "erode" ? 1 : 0;
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let yi = y0; yi <= y1; yi++) {
        if (horizontal[yi * w + x] === test) { v = test; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}
function binaryOpen(mask, w, h, r) {
  if (r <= 0) return mask;
  return morphPass(morphPass(mask, w, h, r, "erode"), w, h, r, "dilate");
}
function binaryClose(mask, w, h, r) {
  if (r <= 0) return mask;
  return morphPass(morphPass(mask, w, h, r, "dilate"), w, h, r, "erode");
}

// Shoelace formula on world-coord ring (signed area).
function ringArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n - 1; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return s / 2;
}

function setStatus(msg) { statusEl.textContent = msg; }
const tick = () => new Promise((r) => setTimeout(r, 0));  // let UI repaint

// ---------- event wiring -----------------------------------------------------
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault(); drop.classList.remove("over");
  if (e.dataTransfer.files[0]) loadTif(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", (e) => { if (e.target.files[0]) loadTif(e.target.files[0]); });
document.getElementById("reset").addEventListener("click", reset);
runBtn.addEventListener("click", digitize);
