// Tiled lookup: loads regional index parts (built by scripts/partition.mjs)
// on demand, choosing parts by the manifest's bounding boxes.
//
//   import { createTiledLookup } from 'latlon2timezone/tiled';
//   const tz = createTiledLookup({
//     manifest: await (await fetch('/parts/manifest.json')).json(),
//     groups: ['countries', 'seas', 'oceans', 'antarctica'],       // a set that covers the world
//     load: async part => new Uint8Array(await (await fetch('/parts/' + part.file)).arrayBuffer()),
//   });
//   await tz.lookup(48.8566, 2.3522);   // 'Europe/Paris' — downloads countries/FR.bin.gz only
//
// `load` must return the *decompressed* bytes (let the server send the .gz with
// Content-Encoding: gzip, or pipe through DecompressionStream('gzip')).
import { createLookup } from './lookup.mjs';

export function createTiledLookup({ manifest, groups, load, onLoad = null }) {
  groups ??= Object.keys(manifest.groups);
  const parts = [];
  for (const g of groups) {
    const grp = manifest.groups[g];
    if (!grp) throw new Error(`manifest has no group "${g}"`);
    for (const p of grp.parts) if (p.bbox) parts.push({ ...p, group: g, area: (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]) });
  }
  parts.sort((a, b) => a.area - b.area); // smallest regions first: a country before its continent, a sea before an ocean
  const loaded = new Map();   // part.file -> lookup instance
  const pending = new Map();  // part.file -> Promise

  function wrap(lat, lon) { lon = ((lon + 180) % 360 + 360) % 360 - 180; if (lat > 90) lat = 90; else if (lat < -90) lat = -90; return [lat, lon]; }
  function candidates(lat, lon) {
    [lat, lon] = wrap(lat, lon);
    return parts.filter(p => lon >= p.bbox[0] && lon <= p.bbox[2] && lat >= p.bbox[1] && lat <= p.bbox[3]);
  }
  function get(part) {
    const have = loaded.get(part.file);
    if (have) return have;
    let pr = pending.get(part.file);
    if (!pr) {
      pr = Promise.resolve(load(part)).then(bytes => { const lk = createLookup(bytes); loaded.set(part.file, lk); pending.delete(part.file); onLoad?.(part, lk); return lk; });
      pending.set(part.file, pr);
    }
    return pr;
  }

  return {
    parts,
    /** Parts whose bbox contains the point, smallest first. */
    candidates,
    /** Async lookup: loads parts as needed. Resolves to an IANA id or null. */
    async lookup(lat, lon) {
      if (lat !== lat || lon !== lon) return null;
      for (const p of candidates(lat, lon)) {
        const z = (await get(p)).lookup(lat, lon);
        if (z !== null) return z;
      }
      return null;
    },
    /** Sync lookup using only already-loaded parts; returns undefined when a needed part is not loaded yet. */
    lookupSync(lat, lon) {
      if (lat !== lat || lon !== lon) return null;
      for (const p of candidates(lat, lon)) {
        const lk = loaded.get(p.file);
        if (!lk) return undefined;
        const z = lk.lookup(lat, lon);
        if (z !== null) return z;
      }
      return null;
    },
    /** Preload parts by name/file, or every part covering a bbox [minLon,minLat,maxLon,maxLat]. */
    async preload(sel) {
      const list = Array.isArray(sel) && sel.length === 4 && sel.every(Number.isFinite)
        ? parts.filter(p => p.bbox[2] >= sel[0] && p.bbox[0] <= sel[2] && p.bbox[3] >= sel[1] && p.bbox[1] <= sel[3])
        : parts.filter(p => sel.includes(p.name) || sel.includes(p.file));
      await Promise.all(list.map(get));
      return list.map(p => p.file);
    },
    loadedParts() { return [...loaded.keys()]; },
    unload(file) { loaded.delete(file); },
  };
}
