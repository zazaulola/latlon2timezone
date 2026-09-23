// Correctness test: compares the compressed lookup with an exact even-odd
// point-in-polygon over the ORIGINAL GeoJSON. Test points: uniform random on
// the sphere + "border" points sampled near polygon vertices (the hard case).
// Reference answers are cached in data/reference-points.json.
//
//   node test/reference.mjs [--data data/tz.bin] [--n 20000] [--tol 0.0001] [--regen]
//
// Pass criterion: every mismatch must lie within --tol degrees (the build's
// simplification tolerance) + quantization slack of the true zone boundary,
// i.e. simplification may only move a border by at most the tolerance.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pointInRing, ringBBox } from '../src/geom.mjs';
import { createLookup } from '../src/lookup.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : null).filter(Boolean));
const DATA = args.data ?? 'data/tz.bin';
const N = +(args.n ?? 20000);
const CACHE = 'data/reference-points.json';
const SRC = 'data/raw/combined-with-oceans.json';

// Deterministic PRNG so the point set is reproducible.
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

let points; // [{lat, lon, kind, ref}]
if (!args.regen && fs.existsSync(CACHE)) {
  points = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  if (points.length !== N) points = null;
}
if (!points) {
  console.log('computing reference answers from', SRC, '...');
  const t0 = performance.now();
  const fc = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  // rings: flat arrays + bbox + owner feature; per-feature list of rings.
  const feats = fc.features.map((f, fi) => {
    const g = f.geometry; const pgs = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const rings = [];
    for (const pg of pgs) for (const coords of pg) {
      const n = coords.length - 1; const r = new Float64Array(n * 2);
      for (let i = 0; i < n; i++) { r[2 * i] = coords[i][0]; r[2 * i + 1] = coords[i][1]; }
      rings.push({ r, bb: ringBBox(r) });
    }
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const { bb: b } of rings) bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])];
    return { tz: f.properties.tzid, rings, bb };
  });
  // 2-degree grid of feature ids for candidate filtering.
  const G = 2, GW = 360 / G, GH = 180 / G;
  const grid = Array.from({ length: GW * GH }, () => []);
  feats.forEach((f, fi) => {
    const cx0 = Math.max(0, Math.floor((f.bb[0] + 180) / G)), cx1 = Math.min(GW - 1, Math.floor((f.bb[2] + 180) / G));
    const cy0 = Math.max(0, Math.floor((f.bb[1] + 90) / G)), cy1 = Math.min(GH - 1, Math.floor((f.bb[3] + 90) / G));
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) grid[y * GW + x].push(fi);
  });
  function reference(lat, lon) {
    const gx = Math.min(GW - 1, Math.floor((lon + 180) / G)), gy = Math.min(GH - 1, Math.floor((lat + 90) / G));
    const hits = [];
    for (const fi of grid[gy * GW + gx]) {
      const f = feats[fi];
      if (lon < f.bb[0] || lon > f.bb[2] || lat < f.bb[1] || lat > f.bb[3]) continue;
      let inside = false;
      for (const { r, bb } of f.rings) {
        if (lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
        if (pointInRing(r, lon, lat)) inside = !inside;
      }
      if (inside) hits.push(f.tz);
    }
    return hits; // normally exactly one
  }
  const rnd = mulberry32(20260907);
  points = [];
  const nRandom = Math.floor(N / 2), nBorder = N - nRandom;
  for (let i = 0; i < nRandom; i++) {
    const lon = rnd() * 360 - 180, lat = Math.asin(rnd() * 2 - 1) * 180 / Math.PI; // uniform on sphere
    points.push({ lat: +lat.toFixed(6), lon: +lon.toFixed(6), kind: 'random' });
  }
  // Border points: pick a random land vertex, jitter by up to ~0.02 deg (~2 km).
  const landFeats = feats.filter(f => !f.tz.startsWith('Etc/'));
  const totalV = landFeats.reduce((s, f) => s + f.rings.reduce((t, r) => t + r.r.length / 2, 0), 0);
  for (let i = 0; i < nBorder; i++) {
    let k = Math.floor(rnd() * totalV), f, ring;
    outer: for (f of landFeats) for (const rr of f.rings) { const n = rr.r.length / 2; if (k < n) { ring = rr.r; break outer; } k -= n; }
    const scale = i % 2 ? 0.02 : 0.002; // half the points within ~200 m of the border
    const lon = ring[2 * k] + (rnd() * 2 - 1) * scale, lat = ring[2 * k + 1] + (rnd() * 2 - 1) * scale;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) { i--; continue; }
    points.push({ lat: +lat.toFixed(6), lon: +lon.toFixed(6), kind: scale < 0.01 ? 'border-200m' : 'border-2km' });
  }
  let multi = 0, none = 0;
  for (const p of points) { const h = reference(p.lat, p.lon); if (h.length > 1) multi++; if (h.length === 0) none++; p.ref = h[0] ?? null; p.refAll = h.length === 1 ? undefined : h; }
  fs.writeFileSync(CACHE, JSON.stringify(points));
  console.log(`reference done in ${((performance.now() - t0) / 1000).toFixed(1)}s; points=${points.length}, in multiple zones=${multi}, in no zone=${none}`);
}

const raw = DATA.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(DATA)) : fs.readFileSync(DATA);
const tz = createLookup(raw);
const zoneSet = new Set(tz.zones);
const regional = tz.meta.selection && tz.meta.selection !== 'world';
const bbox = regional ? tz.meta.selection.bbox : null;
if (regional) console.log(`regional build: ${zoneSet.size} zones, selection ${JSON.stringify(tz.meta.selection)}; points outside must return null`);
const inBbox = p => !bbox || (p.lon >= bbox[0] && p.lon <= bbox[2] && p.lat >= bbox[1] && p.lat <= bbox[3]);
const byKind = {};
const mismatches = [];
for (const p of points) {
  const got = tz.lookup(p.lat, p.lon);
  const candidates = p.refAll ?? [p.ref];        // zones the point truly lies in (usually one)
  const inBuild = inBbox(p) ? candidates.filter(z => zoneSet.has(z)) : [];
  const kind = regional && inBuild.length === 0 ? 'outside-region' : p.kind;
  const s = (byKind[kind] ??= { n: 0, bad: 0 });
  s.n++;
  const ok = got === null ? inBuild.length === 0 : inBuild.includes(got);
  if (!ok) { s.bad++; mismatches.push({ ...p, got }); }
}
console.log(`data=${DATA} (${(tz.bytes / 1e6).toFixed(2)} MB, depth ${tz.depth})`);
for (const [k, s] of Object.entries(byKind)) console.log(`  ${k.padEnd(14)} n=${s.n}  mismatches=${s.bad}  (${(100 * s.bad / s.n).toFixed(3)}%)`);
if (mismatches.length) {
  console.log('sample mismatches:', mismatches.slice(0, 8).map(m => `${m.lat},${m.lon}: got ${m.got}, ref ${m.ref}`).join('\n  '));
}
// Verify every mismatch is within tolerance of the boundary between the two zones.
const TOL = +(args.tol ?? 0.0001);
const SLACK = 2e-5; // 16-bit quantization + clipping round-off
if (mismatches.length) {
  const fc = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const ringsOf = new Map();
  for (const f of fc.features) {
    const g = f.geometry; const pgs = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    ringsOf.set(f.properties.tzid, pgs.flat().map(coords => { const r = new Float64Array(coords.length * 2); coords.forEach((c, i) => { r[2 * i] = c[0]; r[2 * i + 1] = c[1]; }); return r; }));
  }
  function distToRings(rings, x, y) {
    let best = Infinity;
    for (const r of rings) for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const ax = r[j], ay = r[j + 1], bx = r[i], by = r[i + 1];
      const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
      let t = L2 ? ((x - ax) * vx + (y - ay) * vy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - ax - t * vx, dy = y - ay - t * vy; const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
  let maxD = 0;
  for (const m of mismatches) {
    // distance to the boundary of the zone we returned (it was extended by <= tol) and of the true zone
    const d = Math.min(distToRings(ringsOf.get(m.ref) ?? [], m.lon, m.lat), m.got ? distToRings(ringsOf.get(m.got) ?? [], m.lon, m.lat) : Infinity);
    // (a point returned as null must be within tol of the boundary of its true zone; a point
    //  wrongly assigned to zone X must be within tol of X's boundary)
    m.dist = d; if (d > maxD) maxD = d;
  }
  console.log(`max distance of a mismatched point from the true boundary: ${maxD.toExponential(2)} deg (~${(maxD * 111000).toFixed(1)} m); allowed ${(TOL + SLACK).toExponential(2)}`);
  if (maxD > TOL + SLACK) { console.log('FAIL: a mismatch lies farther from the boundary than the simplification tolerance'); process.exit(1); }
}
console.log('PASS');
