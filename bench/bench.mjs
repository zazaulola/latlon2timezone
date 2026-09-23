// Benchmark: load time, memory, throughput on random points, on border-heavy
// points, and on a fixed city list. Targets are asserted at the end.
//
//   node bench/bench.mjs [--data data/tz.bin] [--seconds 2]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createLookup } from '../src/lookup.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : null).filter(Boolean));
const DATA = args.data ?? 'data/tz.bin';
const SECONDS = +(args.seconds ?? 2);
// Conservative thresholds (measured ~4x higher on an Apple Silicon laptop, see README).
const TARGETS = { randomOpsPerSec: 2_000_000, borderOpsPerSec: 200_000, loadMs: 200 };

const len = z => z === null ? 1 : z.length; // null = outside a regional build
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const fmt = n => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

// ---- load ----
const memBefore = process.memoryUsage().rss;
const tLoad = performance.now();
const file = fs.readFileSync(DATA);
const raw = DATA.endsWith('.gz') ? zlib.gunzipSync(file) : file;
const tz = createLookup(raw);
const loadMs = performance.now() - tLoad;
tz.lookup(0, 0);
const memAfter = process.memoryUsage().rss;

// ---- point sets ----
const rnd = mulberry32(42);
const M = 1 << 20;
const randLat = new Float64Array(M), randLon = new Float64Array(M);
for (let i = 0; i < M; i++) { randLon[i] = rnd() * 360 - 180; randLat[i] = Math.asin(rnd() * 2 - 1) * 180 / Math.PI; }
// Land-heavy set: random points, keep only those on land (non Etc/*) -> realistic "user coordinates".
const landLat = [], landLon = [];
for (let i = 0; landLat.length < M / 4 && i < M; i++) { { const z = tz.lookup(randLat[i], randLon[i]); if (z && !z.startsWith('Etc/'))  { landLat.push(randLat[i]); landLon.push(randLon[i]); } } }
// Border-heavy set: points from the reference set that live in poly leaves (jittered polygon vertices).
let borderLat = [], borderLon = [];
if (fs.existsSync('data/reference-points.json')) {
  for (const p of JSON.parse(fs.readFileSync('data/reference-points.json', 'utf8'))) if (p.kind.startsWith('border')) { borderLat.push(p.lat); borderLon.push(p.lon); }
}
const cities = [[55.7558, 37.6173], [48.8566, 2.3522], [40.7128, -74.006], [35.6762, 139.6503], [-33.8688, 151.2093], [22.5726, 88.3639], [51.5074, -0.1278], [19.4326, -99.1332], [-23.5505, -46.6333], [30.0444, 31.2357], [1.3521, 103.8198], [41.0082, 28.9784], [25.2048, 55.2708], [37.7749, -122.4194], [-1.2921, 36.8219], [59.9139, 10.7522]];

function run(name, lats, lons, target) {
  const n = lats.length;
  let ops = 0, sink = 0;
  // warmup
  for (let i = 0; i < Math.min(n, 100000); i++) sink += len(tz.lookup(lats[i], lons[i]));
  const start = performance.now();
  let i = 0;
  while (true) {
    for (let k = 0; k < 8192; k++) { sink += len(tz.lookup(lats[i], lons[i])); if (++i === n) i = 0; }
    ops += 8192;
    if (performance.now() - start > SECONDS * 1000) break;
  }
  const secs = (performance.now() - start) / 1000;
  const rate = ops / secs;
  const ok = target ? rate >= target : true;
  if (!n) { console.log(`${name.padEnd(28)} (no points)`); return true; }
  console.log(`${name.padEnd(28)} ${fmt(rate).padStart(12)} ops/s   ${(1e9 / rate).toFixed(0).padStart(6)} ns/op ${target ? (ok ? '  ✓ target ' + fmt(target) : '  ✗ target ' + fmt(target)) : ''}`);
  return ok && sink > 0;
}

console.log(`data: ${DATA}  ${(tz.bytes / 1e6).toFixed(2)} MB in memory, depth ${tz.depth}, ${tz.zones.length} zones`);
console.log(`load: ${loadMs.toFixed(1)} ms (read${DATA.endsWith('.gz') ? ' + gunzip' : ''} + parse)  ${loadMs <= TARGETS.loadMs ? '✓' : '✗'} target ${TARGETS.loadMs} ms;  RSS +${((memAfter - memBefore) / 1e6).toFixed(1)} MB`);
console.log(`node ${process.version}, ${process.arch}; ${SECONDS}s per case\n`);
let ok = true;
ok &= run('uniform random (70% ocean)', randLat, randLon, TARGETS.randomOpsPerSec);
ok &= run('random land points', landLat, landLon);
if (borderLat.length) ok &= run('near-border points (<2 km)', borderLat, borderLon, TARGETS.borderOpsPerSec);
ok &= run('16 big cities', cities.map(c => c[0]), cities.map(c => c[1]));
console.log(ok && loadMs <= TARGETS.loadMs ? '\nALL TARGETS MET' : '\nSOME TARGETS MISSED');
process.exit(ok && loadMs <= TARGETS.loadMs ? 0 : 1);
