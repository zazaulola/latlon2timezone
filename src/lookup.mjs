// Runtime: environment-agnostic (Node / browser / workers). No dependencies.
//
//   import { createLookup } from 'latlon2timezone/lookup';
//   const tz = createLookup(arrayBuffer);   // decompressed tz.bin contents
//   tz.lookup(55.75, 37.62);                // -> 'Europe/Moscow'

/**
 * @param {ArrayBuffer|Uint8Array} data  decompressed contents of tz.bin
 * @returns {{ lookup(lat:number, lon:number): string|null, zones: string[], meta: object, depth: number, bytes: number }}
 */
export function createLookup(data) {
  let u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.byteOffset & 3) u8 = u8.slice(); // typed-array views below need 4-byte alignment
  const buf = u8.buffer, base = u8.byteOffset;
  const dv = new DataView(buf, base, u8.byteLength);
  if (dv.getUint32(0, false) !== 0x545a5131 /* 'TZQ1' */) throw new Error('latlon2timezone: bad data file');
  const depth = u8[5];
  const qmax = u8[6] ? (1 << u8[6]) - 1 : 65535; // quantization range per axis in poly leaves
  const zoneCount = dv.getUint32(8, true);
  const namesOff = dv.getUint32(12, true), namesLen = dv.getUint32(16, true);
  const nodesOff = dv.getUint32(20, true), nodesCount = dv.getUint32(24, true);
  const leafOff = dv.getUint32(28, true), leafCount = dv.getUint32(32, true);
  const blobOff = dv.getUint32(36, true), blobLen = dv.getUint32(40, true);
  const table = JSON.parse(new TextDecoder().decode(u8.subarray(namesOff, namesOff + namesLen)));
  const zones = Array.isArray(table) ? table : table.zones;
  const meta = Array.isArray(table) ? {} : table.meta ?? {}; // { release, depth, tol, bits, selection: 'world' | { countries, zonePatterns, bbox } }
  if (zones.length !== zoneCount) throw new Error('latlon2timezone: corrupt zone table');
  const nodes = new Int32Array(buf, base + nodesOff, nodesCount);
  const leaves = new Uint32Array(buf, base + leafOff, leafCount);
  const blob = u8.subarray(blobOff, blobOff + blobLen);

  // Varint reader state (module-local, single-threaded per instance).
  let pos = 0;
  function readVarint() {
    let b = blob[pos++];
    if (b < 0x80) return b;
    let v = b & 0x7f, shift = 7;
    do { b = blob[pos++]; v |= (b & 0x7f) << shift; shift += 7; } while (b >= 0x80);
    return v;
  }
  function readSigned() { const v = readVarint(); return (v & 1) ? -((v + 1) >>> 1) : v >>> 1; }

  /**
   * @param {number} lat  degrees, [-90, 90]
   * @param {number} lon  degrees, any value (wrapped into [-180, 180))
   * @returns {string|null} IANA zone id; null for NaN input or for points outside a regional build's coverage
   */
  function lookup(lat, lon) {
    if (lat !== lat || lon !== lon) return null;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;            // wrap to [-180, 180)
    if (lat > 90) lat = 90; else if (lat < -90) lat = -90;
    if (lat === 90) lat = 89.999999;                        // keep inside the top row of cells
    let x0 = -180, y0 = -90, w = 360, h = 180;
    let ref = 0;
    for (let d = 0; d < depth; d++) {
      w *= 0.5; h *= 0.5;
      const mx = x0 + w, my = y0 + h;
      let q = 0;
      if (lon >= mx) { q = 1; x0 = mx; }
      if (lat >= my) { q |= 2; y0 = my; }
      ref = nodes[(ref << 2) | q];
      if (ref < 0) break;
    }
    if (ref >= 0) return null; // cannot happen with a well-formed file
    const v = -ref - 1;
    if ((v & 1) === 0) return v === 0x7ffffff * 2 ? null : zones[v >>> 1]; // null = outside the built region

    // Poly leaf: test stored rings (even-odd) in quantized cell coordinates.
    pos = leaves[v >>> 1];
    const defZone = readVarint();
    const others = readVarint();
    const px = (lon - x0) * (qmax / w), py = (lat - y0) * (qmax / h);
    for (let k = 0; k < others; k++) {
      const zone = readVarint();
      const nRings = readVarint();
      let inside = false;
      for (let r = 0; r < nRings; r++) {
        const n = readVarint();
        let cx = readSigned(), cy = readSigned();
        const fx = cx, fy = cy;               // first vertex, needed to close the ring
        let ax = cx, ay = cy;
        for (let i = 1; i < n; i++) {
          cx = ax + readSigned(); cy = ay + readSigned();
          if ((cy > py) !== (ay > py) && px < ((ax - cx) * (py - cy)) / (ay - cy) + cx) inside = !inside;
          ax = cx; ay = cy;
        }
        // closing edge last -> first
        if ((fy > py) !== (ay > py) && px < ((ax - fx) * (py - fy)) / (ay - fy) + fx) inside = !inside;
      }
      if (inside) return zones[zone];
    }
    return zones[defZone] ?? null; // defZone === zones.length means "no zone" (regional builds)
  }

  return { lookup, zones, meta, depth, bytes: u8.byteLength };
}
