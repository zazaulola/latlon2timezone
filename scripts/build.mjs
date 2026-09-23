// CLI: builds one index file from combined-with-oceans.json.
//
//   node scripts/build.mjs [--depth 11] [--tol 0.0001] [--bits 16] [--out data/tz.bin]
//                          [--countries US,CA,MX] [--zones 'America/*,Etc/GMT+5'] [--bbox minLon,minLat,maxLon,maxLat]
//
// Regional builds: --countries (ISO 3166-1 alpha-2, resolved through tzdb's
// zone.tab / zone1970.tab), --zones (comma-separated globs) and --bbox restrict
// the geometry that is stored. Everything outside the selection is "no zone"
// and lookup() returns null there. The algorithm lives in src/build-index.mjs;
// scripts/partition.mjs builds whole sets of regional files at once.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildIndex, geometryToRings, clipRings, ringsBBox, parseZoneTab, zonesForCountries, globToRegExp } from '../src/build-index.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null).filter(Boolean));
const DEPTH = +(args.depth ?? 11), TOL = +(args.tol ?? 0.0001), BITS = +(args.bits ?? 16);
const OUT = args.out ?? 'data/tz.bin';
const SRC = args.src ?? 'data/raw/combined-with-oceans.json';

const selCountries = args.countries ? args.countries.split(',').map(c => c.trim().toUpperCase()).filter(Boolean) : [];
const selPatterns = args.zones ? args.zones.split(',').map(p => p.trim()).filter(Boolean) : [];
const bbox = args.bbox ? args.bbox.split(',').map(Number) : null;
if (bbox && (bbox.length !== 4 || bbox.some(Number.isNaN))) throw new Error('--bbox expects minLon,minLat,maxLon,maxLat');
const PARTIAL = selCountries.length > 0 || selPatterns.length > 0 || !!bbox;

const t0 = performance.now();
const fc = JSON.parse(fs.readFileSync(SRC, 'utf8'));
let features = fc.features;
if (selCountries.length || selPatterns.length) {
  const read = f => fs.existsSync(f) ? parseZoneTab(fs.readFileSync(f, 'utf8')) : null;
  const zt = read('data/raw/zone.tab');
  if (selCountries.length && !zt) throw new Error('data/raw/zone.tab missing — run `npm run download`');
  const wanted = selCountries.length ? zonesForCountries(selCountries, zt, read('data/raw/zone1970.tab')) : new Set();
  const res = selPatterns.map(globToRegExp);
  features = features.filter(f => wanted.has(f.properties.tzid) || res.some(re => re.test(f.properties.tzid)));
  const missing = [...wanted].filter(z => !fc.features.some(f => f.properties.tzid === z));
  if (missing.length) console.warn('warning: zones from country table not in dataset:', missing.join(', '));
  if (!features.length) throw new Error('selection matches no zones');
}
// Validate every name against Intl (throws RangeError for unknown zones).
for (const f of features) new Intl.DateTimeFormat('en', { timeZone: f.properties.tzid });

const items = [], zones = [];
let srcVerts = 0;
for (const f of features) {
  let rings = geometryToRings(f.geometry);
  for (const r of rings) srcVerts += r.length / 2;
  if (bbox) {
    const [x0, y0, x1, y1] = ringsBBox(rings);
    if (x1 < bbox[0] || x0 > bbox[2] || y1 < bbox[1] || y0 > bbox[3]) continue;
    rings = clipRings(rings, bbox[0], bbox[1], bbox[2], bbox[3]);
    if (!rings.length) continue;
  }
  items.push({ zone: zones.length, rings });
  zones.push(f.properties.tzid);
}
console.log(`loaded ${zones.length} zones${PARTIAL ? ' (regional build)' : ''}, ${srcVerts} vertices in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const release = fs.existsSync('data/raw/RELEASE') ? fs.readFileSync('data/raw/RELEASE', 'utf8').trim() : undefined;
const selection = PARTIAL ? { countries: selCountries, zonePatterns: selPatterns, bbox } : 'world';
const t1 = performance.now();
const { buffer, stats } = buildIndex({ items, zones, depth: DEPTH, tol: TOL, bits: BITS, partial: PARTIAL, meta: { release, selection } });
console.log(`quadtree built in ${((performance.now() - t1) / 1000).toFixed(1)}s`);

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(OUT, buffer);
const gz = zlib.gzipSync(buffer, { level: 9 });
fs.writeFileSync(OUT + '.gz', gz);
const br = zlib.brotliCompressSync(buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
console.log(JSON.stringify({
  depth: DEPTH, tol: TOL, bits: BITS, out: OUT, zones: zones.length, selection,
  ...stats, srcVerts, bytes: { ...stats.bytes, gzip: gz.length, brotli: br.length },
  buildSeconds: +((performance.now() - t0) / 1000).toFixed(1),
}, null, 1));
