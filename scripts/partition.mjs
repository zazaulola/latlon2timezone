// Splits the world into a set of regional index files + a manifest:
//
//   continents  land by continent (zone-based; Antarctica excluded, see below)
//   countries   land by country (zone.tab; countries without a zone of their own
//               get the shared zone from zone1970.tab, flagged sharedZones)
//   seas        waters by sea/gulf/bay/strait (Natural Earth 50m marine polygons)
//   oceans      waters by ocean (Natural Earth; gaps in the polygon set go to the nearest ocean)
//   antarctica  Antarctica/* zones
//
//   node scripts/partition.mjs [--out data/parts] [--groups continents,oceans] [--only part-name]
//                              [--depth 11] [--tol 0.0001] [--dump-config file] [--config file]
//
// Output: <out>/<group>/<part>.bin.gz and <out>/manifest.json (bbox, zones, sizes
// per part) for src/tiled.mjs, which fetches parts on demand by coordinate.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildIndex, geometryToRings, ringsBBox, parseZoneTab, AREA_EPS } from '../src/build-index.mjs';
import { signedArea } from '../src/geom.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : null).filter(Boolean));
const OUT = args.out ?? 'data/parts';
const DEPTH = +(args.depth ?? 11), TOL = +(args.tol ?? 0.0001), BITS = +(args.bits ?? 16);
const ONLY_GROUPS = args.groups ? new Set(args.groups.split(',')) : null;
const ONLY_PART = args.only ?? null;

const t0 = performance.now();
const fc = JSON.parse(fs.readFileSync('data/raw/combined-with-oceans.json', 'utf8'));
const release = fs.existsSync('data/raw/RELEASE') ? fs.readFileSync('data/raw/RELEASE', 'utf8').trim() : undefined;
const zoneTab = parseZoneTab(fs.readFileSync('data/raw/zone.tab', 'utf8'));
const zone1970 = parseZoneTab(fs.readFileSync('data/raw/zone1970.tab', 'utf8'));
const marine = JSON.parse(fs.readFileSync('data/raw/ne_50m_marine.geojson', 'utf8')).features;

// zone geometry, normalised once
const zoneRings = new Map(), zoneBBox = new Map();
for (const f of fc.features) { const r = geometryToRings(f.geometry); zoneRings.set(f.properties.tzid, r); zoneBBox.set(f.properties.tzid, ringsBBox(r)); }
const allZones = [...zoneRings.keys()];
const countryOf = new Map(zoneTab.map(e => [e.tz, e.countries[0]]));
console.log(`loaded ${allZones.length} zones, ${marine.length} marine polygons in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// ---------------- default configuration ----------------
const SOUTH_AMERICA = new Set(['AR', 'BO', 'BR', 'CL', 'CO', 'EC', 'FK', 'GF', 'GY', 'PE', 'PY', 'SR', 'UY', 'VE', 'GS']);
const CONTINENT_OVERRIDES = {
  'Europe/Istanbul': 'asia',            // zone covers all of Turkey, 97% of it in Asia
  'Atlantic/Bermuda': 'north_america', 'Atlantic/Canary': 'africa', 'Atlantic/Cape_Verde': 'africa', 'Atlantic/St_Helena': 'africa',
  'Atlantic/Azores': 'europe', 'Atlantic/Madeira': 'europe', 'Atlantic/Faroe': 'europe', 'Atlantic/Reykjavik': 'europe', 'Atlantic/Jan_Mayen': 'europe',
  'Atlantic/South_Georgia': 'south_america', 'Atlantic/Stanley': 'south_america',
  'Arctic/Longyearbyen': 'europe',
  'Indian/Maldives': 'asia', 'Indian/Chagos': 'asia',
  'Indian/Kerguelen': 'antarctica',     // French sub-antarctic islands
  'Pacific/Honolulu': 'oceania', 'Pacific/Easter': 'oceania', 'Pacific/Galapagos': 'south_america',
};
function continentOf(tz) {
  if (CONTINENT_OVERRIDES[tz]) return CONTINENT_OVERRIDES[tz];
  const p = tz.split('/')[0];
  if (p === 'Africa') return 'africa'; if (p === 'Europe') return 'europe'; if (p === 'Asia') return 'asia';
  if (p === 'Australia' || p === 'Pacific') return 'oceania'; if (p === 'Antarctica') return 'antarctica';
  if (p === 'Indian') return 'africa';
  if (p === 'America') return SOUTH_AMERICA.has(countryOf.get(tz)) ? 'south_america' : 'north_america';
  if (p === 'Etc') return null;
  throw new Error('no continent rule for ' + tz);
}
const slug = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function defaultConfig() {
  const cfg = { depth: DEPTH, tol: TOL, bits: BITS, groups: {} };
  // continents (Antarctica has its own group)
  const cont = {};
  for (const tz of allZones) { const c = continentOf(tz); if (c && c !== 'antarctica') (cont[c] ??= { zones: [] }).zones.push(tz); }
  cfg.groups.continents = { type: 'zones', parts: cont };
  cfg.groups.antarctica = { type: 'zones', parts: { antarctica: { zones: allZones.filter(tz => continentOf(tz) === 'antarctica') } } };
  // countries
  const byCountry = {};
  for (const tz of allZones) { const cc = countryOf.get(tz); if (cc) (byCountry[cc] ??= { zones: [] }).zones.push(tz); }
  const seen = new Set(Object.keys(byCountry));
  for (const e of zone1970) for (const cc of e.countries) if (!seen.has(cc) && zoneRings.has(e.tz)) { (byCountry[cc] ??= { zones: [], sharedZones: true }).zones.push(e.tz); }
  cfg.groups.countries = { type: 'zones', parts: Object.fromEntries(Object.entries(byCountry).sort()) };
  // seas / oceans from Natural Earth (index into the marine feature list)
  const seas = {}, oceans = {};
  marine.forEach((f, i) => {
    const cls = f.properties.featurecla;
    if (cls === 'river' || cls === 'reef') return;
    const target = cls === 'ocean' ? oceans : seas;
    let name = slug(f.properties.name); while (target[name]) name += '-2';
    target[name] = { marine: i, title: f.properties.name, featurecla: cls };
  });
  cfg.groups.seas = { type: 'mask', parts: seas };
  cfg.groups.oceans = { type: 'mask', parts: oceans, gapsToNearest: true };
  return cfg;
}
const config = args.config ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : defaultConfig();
if (args['dump-config']) { fs.mkdirSync(path.dirname(args['dump-config']), { recursive: true }); fs.writeFileSync(args['dump-config'], JSON.stringify(config, null, 1)); console.log('config written to', args['dump-config']); }

// ---------------- mask geometry ----------------
const marineRings = marine.map(f => geometryToRings(f.geometry));
const oceanIdx = marine.map((f, i) => f.properties.featurecla === 'ocean' ? i : -1).filter(i => i >= 0);
const etcZones = new Set(allZones.filter(z => z.startsWith('Etc/')));
// nearest ocean to a point (distance to polygon edges, degrees) — used for gaps in the marine dataset
const nearestCache = new Map();
function nearestOcean(x, y) {
  const key = (Math.round(x * 8) << 12) ^ Math.round(y * 8);
  if (nearestCache.has(key)) return nearestCache.get(key);
  let best = Infinity, who = -1;
  for (const i of oceanIdx) {
    for (const r of marineRings[i]) for (let k = 0, j = r.length - 2; k < r.length; j = k, k += 2) {
      const ax = r[j], ay = r[j + 1], bx = r[k], by = r[k + 1];
      const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
      let t = L2 ? ((x - ax) * vx + (y - ay) * vy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - ax - t * vx, dy = y - ay - t * vy, d = dx * dx + dy * dy;
      if (d < best) { best = d; who = i; }
    }
  }
  nearestCache.set(key, who);
  return who;
}

// ---------------- build parts ----------------
fs.mkdirSync(OUT, { recursive: true });
// Partial runs (--groups / --only) merge into an existing manifest instead of replacing it.
const manifestPath = path.join(OUT, 'manifest.json');
const previous = (ONLY_GROUPS || ONLY_PART) && fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
const manifest = { release, depth: DEPTH, tol: TOL, bits: BITS, generated: new Date().toISOString(), groups: previous?.groups ?? {} };
let built = 0, totalGz = 0;
for (const [gname, g] of Object.entries(config.groups)) {
  if (ONLY_GROUPS && !ONLY_GROUPS.has(gname)) continue;
  fs.mkdirSync(path.join(OUT, gname), { recursive: true });
  const parts = [];
  for (const [pname, p] of Object.entries(g.parts)) {
    if (ONLY_PART && pname !== ONLY_PART) continue;
    const tp = performance.now();
    let items, zones, mask = null, partial = true, extra = {};
    if (g.type === 'zones') {
      zones = p.zones.filter(z => zoneRings.has(z));
      if (!zones.length) { console.warn(`  skip ${gname}/${pname}: no geometry`); continue; }
      items = zones.map((z, i) => ({ zone: i, rings: zoneRings.get(z) }));
      if (p.sharedZones) extra.sharedZones = true;
    } else {
      const mi = p.marine;
      const target = marineRings[mi];
      const [mx0, my0, mx1, my1] = ringsBBox(target);
      // neighbouring regions: every other marine polygon (all of them; they are clipped hierarchically)
      const others = marineRings.flatMap((r, i) => i === mi ? [] : r);
      const gapFallback = g.gapsToNearest ? box => nearestOcean((box[0] + box[2]) / 2, (box[1] + box[3]) / 2) === mi : null;
      // all zones whose bbox touches the mask bbox (+ margin for gap assignment when enabled)
      const m = g.gapsToNearest ? 30 : 0.5;
      zones = allZones.filter(z => { const b = zoneBBox.get(z); return b[2] >= mx0 - m && b[0] <= mx1 + m && b[3] >= my0 - m && b[1] <= my1 + m; });
      items = zones.map((z, i) => ({ zone: i, rings: zoneRings.get(z) }));
      mask = { target, others, gapFallback, waterZones: new Set(zones.map((z, i) => etcZones.has(z) ? i : -1).filter(i => i >= 0)) };
      extra = { title: p.title, featurecla: p.featurecla, maskBBox: [mx0, my0, mx1, my1].map(v => +v.toFixed(4)) };
    }
    const { buffer, stats } = buildIndex({ items, zones, depth: config.depth, tol: config.tol, bits: config.bits, partial, mask, meta: { release, selection: { group: gname, part: pname, ...extra } } });
    const gz = zlib.gzipSync(buffer, { level: 9 });
    const file = `${gname}/${pname}.bin.gz`;
    fs.writeFileSync(path.join(OUT, file), gz);
    const usedZones = stats.bbox ? zones : [];
    parts.push({ name: pname, file, ...extra, zones: usedZones, bbox: stats.bbox ? stats.bbox.map(v => +v.toFixed(4)) : null, bytes: buffer.length, gzipBytes: gz.length, storedVerts: stats.storedVerts });
    built++; totalGz += gz.length;
    console.log(`  ${gname}/${pname}: ${zones.length} zones, ${(buffer.length / 1e3).toFixed(0)} kB (${(gz.length / 1e3).toFixed(0)} kB gz), ${((performance.now() - tp) / 1000).toFixed(1)}s`);
  }
  if (ONLY_PART && manifest.groups[gname]) {
    const kept = manifest.groups[gname].parts.filter(p => !parts.some(q => q.name === p.name));
    manifest.groups[gname] = { type: g.type, parts: [...kept, ...parts] };
  } else manifest.groups[gname] = { type: g.type, parts };
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
console.log(`\n${built} parts, ${(totalGz / 1e6).toFixed(2)} MB gzipped total, ${((performance.now() - t0) / 1000).toFixed(0)}s -> ${OUT}/manifest.json`);
