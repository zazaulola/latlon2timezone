// Core index builder (used by scripts/build.mjs and scripts/partition.mjs).
//
// Quadtree over lon [-180,180] x lat [-90,90]. At every node the rings of all
// zones are clipped (Sutherland–Hodgman) to the node's box. A cell with a single
// zone covering it becomes a leaf; at max depth the largest zone becomes the
// implicit default and the other zones' rings are stored quantized + delta/varint
// encoded, optionally Douglas–Peucker simplified (cell-edge vertices anchored).
//
// Optional region mask (for partitions by sea/ocean polygons): `mask.target`
// rings define the region to build, `mask.others` the neighbouring regions.
// Cells fully outside the target become "no zone" (lookup -> null); cells the
// mask only partially covers are refined and, at max depth, included whole
// (overshoot <= one cell). Cells covered by neither target nor others (gaps in
// the mask dataset) are included when `mask.gapFallback(box, items)` says so.
import { signedArea, clipRingToRect, simplifyRing } from './geom.mjs';

export const AREA_EPS = 1e-14;   // deg^2: rings smaller than this are dropped
export const COVER_EPS = 1e-9;   // relative slack for "covers the whole cell"
export const NONE_LEAF = 0x7ffffff * 2;
export const GAP_WATER_EPS = 1e-3; // share of water below which an uncovered cell counts as land

/** GeoJSON geometry -> flat rings, outer rings CCW (+area), holes CW (-area), no repeated closing point. */
export function geometryToRings(g) {
  const pgs = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const rings = [];
  for (const pg of pgs) pg.forEach((coords, k) => {
    let n = coords.length;
    if (n > 1 && coords[0][0] === coords[n - 1][0] && coords[0][1] === coords[n - 1][1]) n--;
    if (n < 3) return;
    const r = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) { r[2 * i] = coords[i][0]; r[2 * i + 1] = coords[i][1]; }
    const a = signedArea(r);
    if (a === 0) return;
    if ((a > 0) !== (k === 0)) reverseRing(r);
    rings.push(r);
  });
  return rings;
}
function reverseRing(r) { const n = r.length >> 1; for (let i = 0, j = n - 1; i < j; i++, j--) { const x = r[2 * i], y = r[2 * i + 1]; r[2 * i] = r[2 * j]; r[2 * i + 1] = r[2 * j + 1]; r[2 * j] = x; r[2 * j + 1] = y; } }

export function ringsArea(rings) { let a = 0; for (const r of rings) a += signedArea(r); return a; }
export function ringsBBox(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (let i = 0; i < r.length; i += 2) { const x = r[i], y = r[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
/** Clip a ring list to a box, dropping empty/degenerate results. */
export function clipRings(rings, x0, y0, x1, y1) {
  const out = [];
  for (const r of rings) { const c = clipRingToRect(r, x0, y0, x1, y1); if (c.length >= 6 && Math.abs(signedArea(c)) > AREA_EPS) out.push(c); }
  return out;
}

/**
 * @param {object} o
 * @param {{zone:number, rings:Float64Array[]}[]} o.items   zone geometry (zone = index into o.zones)
 * @param {string[]} o.zones          zone names
 * @param {number} [o.depth=11]  @param {number} [o.tol=1e-4]  @param {number} [o.bits=16]
 * @param {boolean} [o.partial]       true when geometry was filtered: a lone zone may not cover its cell
 * @param {{target:Float64Array[], others:Float64Array[], waterZones?:Set<number>, gapFallback?:(box:number[], items:object[])=>boolean}} [o.mask]
 * @param {object} [o.meta]           stored in the file next to the zone table
 * @returns {{ buffer: Uint8Array, stats: object }}
 */
export function buildIndex(o) {
  const DEPTH = o.depth ?? 11, TOL = o.tol ?? 1e-4, BITS = o.bits ?? 16;
  if (BITS < 8 || BITS > 16) throw new Error('bits must be in 8..16');
  const QMAX = (1 << BITS) - 1;
  const zones = o.zones, NONE = zones.length;
  const PARTIAL = !!o.partial || !!o.mask;
  const gapFallback = o.mask?.gapFallback ?? null;
  const waterZones = o.mask?.waterZones ?? null; // Set of zone indices that are open water (Etc/*)

  const nodes = [];            // Int32 child refs, 4 per internal node
  const leafOffsets = [];      // Uint32 blob offsets per poly leaf
  let blob = new Uint8Array(1 << 22), blobLen = 0;
  const stats = { internal: 0, zoneLeaves: 0, polyLeaves: 0, emptyLeaves: 0, storedVerts: 0, storedRings: 0, maxLeafVerts: 0, leafVertHist: {}, bbox: [Infinity, Infinity, -Infinity, -Infinity] };
  const putByte = b => { if (blobLen === blob.length) { const nb = new Uint8Array(blob.length * 2); nb.set(blob); blob = nb; } blob[blobLen++] = b; };
  const putVarint = v => { while (v >= 0x80) { putByte((v & 0x7f) | 0x80); v >>>= 7; } putByte(v); };
  const putSigned = v => putVarint(v >= 0 ? v * 2 : -v * 2 - 1);
  const leafRef = v => -(1 + v);
  const cover = (x0, y0, x1, y1) => { if (x0 < stats.bbox[0]) stats.bbox[0] = x0; if (y0 < stats.bbox[1]) stats.bbox[1] = y0; if (x1 > stats.bbox[2]) stats.bbox[2] = x1; if (y1 > stats.bbox[3]) stats.bbox[3] = y1; };

  function build(items, maskT, maskO, x0, y0, x1, y1, depth) {
    const cellArea = (x1 - x0) * (y1 - y0);
    if (maskT !== null) {
      const aT = ringsArea(maskT), aO = ringsArea(maskO);
      if (aT >= cellArea * (1 - COVER_EPS)) { maskT = maskO = null; }                 // fully inside the region
      else if (aT <= AREA_EPS) {
        if (aO >= cellArea * (1 - COVER_EPS)) { stats.emptyLeaves++; return leafRef(NONE_LEAF); } // belongs to other regions
        const gapHere = aO <= AREA_EPS;                                                  // no region polygon at all
        if (gapHere || depth === DEPTH) {
          // Water not covered by any region polygon. Decide by the share of water zones in the
          // cell: (almost) none -> land / dataset noise -> no zone; (almost) all -> ask gapFallback;
          // mixed -> refine, at max depth ask gapFallback.
          let water = 0; if (waterZones) for (const it of items) if (waterZones.has(it.zone)) water += it.area;
          const frac = water / cellArea;
          if (frac <= GAP_WATER_EPS || !gapFallback) { stats.emptyLeaves++; return leafRef(NONE_LEAF); }
          if (frac >= 1 - GAP_WATER_EPS || depth === DEPTH) {
            if (gapFallback([x0, y0, x1, y1], items)) { maskT = maskO = null; }
            else { stats.emptyLeaves++; return leafRef(NONE_LEAF); }
          }
          // else: mixed land/water gap -> refine
        }
        // else: partly other regions, remainder is a gap -> refine
      } else if (depth === DEPTH) { maskT = maskO = null; }                              // partial at max depth: include whole cell
    }

    if (items.length === 0) { stats.emptyLeaves++; return leafRef(NONE_LEAF); }
    if (items.length === 1 && maskT === null) {
      const covered = !PARTIAL || items[0].area >= cellArea * (1 - COVER_EPS);
      if (covered) { stats.zoneLeaves++; cover(x0, y0, x1, y1); return leafRef(items[0].zone * 2); }
    }
    if (depth === DEPTH) return writePolyLeaf(items, x0, y0, x1, y1);

    const idx = nodes.length; nodes.push(0, 0, 0, 0); stats.internal++;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const boxes = [[x0, y0, mx, my], [mx, y0, x1, my], [x0, my, mx, y1], [mx, my, x1, y1]];
    for (let q = 0; q < 4; q++) {
      const [bx0, by0, bx1, by1] = boxes[q];
      const sub = [];
      for (const it of items) {
        const rings = clipRings(it.rings, bx0, by0, bx1, by1);
        if (rings.length) { const a = ringsArea(rings); if (a > AREA_EPS) sub.push({ zone: it.zone, rings, area: a }); }
      }
      const mT = maskT === null ? null : clipRings(maskT, bx0, by0, bx1, by1);
      const mO = maskT === null ? null : clipRings(maskO, bx0, by0, bx1, by1);
      nodes[idx + q] = build(sub, mT, mO, bx0, by0, bx1, by1, depth + 1);
    }
    return idx >> 2;
  }

  function writePolyLeaf(items, x0, y0, x1, y1) {
    items.sort((a, b) => b.area - a.area);
    const leafIndex = leafOffsets.length;
    leafOffsets.push(blobLen);
    let total = 0; for (const it of items) total += it.area;
    const fullyCovered = !PARTIAL || total >= (x1 - x0) * (y1 - y0) * (1 - COVER_EPS);
    let first = 1;
    if (fullyCovered) putVarint(items[0].zone); else { putVarint(NONE); first = 0; }
    putVarint(items.length - first);
    const sx = QMAX / (x1 - x0), sy = QMAX / (y1 - y0);
    const onCellEdge = (x, y) => x === x0 || x === x1 || y === y0 || y === y1;
    let leafVerts = 0;
    for (let k = first; k < items.length; k++) {
      const it = items[k];
      const qrings = [];
      for (let r of it.rings) {
        if (TOL > 0) r = simplifyRing(r, TOL, onCellEdge);
        const q = [];
        for (let i = 0; i < r.length; i += 2) {
          let qx = Math.round((r[i] - x0) * sx), qy = Math.round((r[i + 1] - y0) * sy);
          qx = qx < 0 ? 0 : qx > QMAX ? QMAX : qx; qy = qy < 0 ? 0 : qy > QMAX ? QMAX : qy;
          const m = q.length;
          if (m && q[m - 2] === qx && q[m - 1] === qy) continue;
          q.push(qx, qy);
        }
        while (q.length >= 4 && q[0] === q[q.length - 2] && q[1] === q[q.length - 1]) q.length -= 2;
        if (q.length >= 6) qrings.push(q);
      }
      putVarint(it.zone);
      putVarint(qrings.length);
      for (const q of qrings) {
        const n = q.length >> 1;
        putVarint(n);
        let px = 0, py = 0;
        for (let i = 0; i < q.length; i += 2) { putSigned(q[i] - px); putSigned(q[i + 1] - py); px = q[i]; py = q[i + 1]; }
        stats.storedVerts += n; stats.storedRings++; leafVerts += n;
      }
    }
    stats.polyLeaves++; cover(x0, y0, x1, y1);
    if (leafVerts > stats.maxLeafVerts) stats.maxLeafVerts = leafVerts;
    const bucket = leafVerts < 64 ? '<64' : leafVerts < 256 ? '<256' : leafVerts < 1024 ? '<1k' : leafVerts < 4096 ? '<4k' : '>=4k';
    stats.leafVertHist[bucket] = (stats.leafVertHist[bucket] ?? 0) + 1;
    return leafRef(leafIndex * 2 + 1);
  }

  const rootItems = o.items.map(it => ({ zone: it.zone, rings: it.rings, area: ringsArea(it.rings) })).filter(it => it.area > AREA_EPS);
  const maskT = o.mask ? o.mask.target : null, maskO = o.mask ? (o.mask.others ?? []) : null;
  const rootRef = build(rootItems, maskT, maskO, -180, -90, 180, 90, 0);
  if (rootRef !== 0) {
    // Degenerate: the whole world is a single leaf (e.g. empty selection). Materialise a root node.
    nodes.length = 0; nodes.push(rootRef, rootRef, rootRef, rootRef); stats.internal = 1;
  }

  // ---- serialise ---- (little endian, sections 4-byte aligned)
  //  0 'TZQ1' | 4 u8 version=1, u8 depth, u8 bits, u8 0 | 8 u32 zoneCount | 12 u32 namesOff | 16 u32 namesLen
  // 20 u32 nodesOff | 24 u32 nodesCount | 28 u32 leafOff | 32 u32 leafCount | 36 u32 blobOff | 40 u32 blobLen | 44 end
  const meta = { depth: DEPTH, tol: TOL, bits: BITS, ...(o.meta ?? {}) };
  const names = new TextEncoder().encode(JSON.stringify({ zones, meta }));
  const align = n => (n + 3) & ~3;
  const namesOff = 44, nodesOff = align(namesOff + names.length);
  const leafOff = nodesOff + nodes.length * 4, blobOff = leafOff + leafOffsets.length * 4;
  const total = align(blobOff + blobLen);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set([0x54, 0x5a, 0x51, 0x31], 0); out[4] = 1; out[5] = DEPTH; out[6] = BITS;
  dv.setUint32(8, zones.length, true); dv.setUint32(12, namesOff, true); dv.setUint32(16, names.length, true);
  dv.setUint32(20, nodesOff, true); dv.setUint32(24, nodes.length, true);
  dv.setUint32(28, leafOff, true); dv.setUint32(32, leafOffsets.length, true);
  dv.setUint32(36, blobOff, true); dv.setUint32(40, blobLen, true);
  out.set(names, namesOff);
  new Int32Array(out.buffer, nodesOff, nodes.length).set(nodes);
  new Uint32Array(out.buffer, leafOff, leafOffsets.length).set(leafOffsets);
  out.set(blob.subarray(0, blobLen), blobOff);
  if (stats.bbox[0] === Infinity) stats.bbox = null;
  stats.bytes = { nodes: nodes.length * 4, leafTable: leafOffsets.length * 4, blob: blobLen, total };
  return { buffer: out, stats };
}

// ---- helpers for zone selection (shared by the CLIs) ----

/** Parse tzdb zone.tab / zone1970.tab text -> [{countries:[...], tz}] */
export function parseZoneTab(text) {
  return text.split('\n').filter(l => l && !l.startsWith('#')).map(l => { const f = l.split('\t'); return { countries: f[0].split(','), tz: f[2] }; });
}
/** ISO country codes -> Set of zone ids (zone.tab first, zone1970.tab for shared zones). */
export function zonesForCountries(codes, zoneTab, zone1970Tab, datasetZones = null) {
  const out = new Set();
  for (const cc of codes) {
    let found = false;
    for (const e of zoneTab) if (e.countries[0] === cc && (!datasetZones || datasetZones.has(e.tz))) { out.add(e.tz); found = true; }
    if (!found && zone1970Tab) for (const e of zone1970Tab) if (e.countries.includes(cc) && (!datasetZones || datasetZones.has(e.tz))) { out.add(e.tz); found = true; }
    if (!found) throw new Error(`unknown country code ${cc}`);
  }
  return out;
}
export function globToRegExp(g) { return new RegExp('^' + g.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'); }
