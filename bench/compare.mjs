// Runs a short throughput benchmark for every built variant in data/ and prints
// a comparison table (size, random-point and near-border throughput).
//   node bench/compare.mjs [--seconds 1] [files...]
import fs from 'node:fs';
import { createLookup } from '../src/lookup.mjs';

const argv = process.argv.slice(2);
const secIdx = argv.indexOf('--seconds');
const SECONDS = secIdx >= 0 ? +argv.splice(secIdx, 2)[1] : 1;
const files = argv.length ? argv : fs.readdirSync('data').filter(f => /^tz-d.*\.bin$/.test(f)).sort().map(f => 'data/' + f);

const len = z => z === null ? 1 : z.length; // null = outside a regional build
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(42);
const M = 1 << 18;
const randLat = new Float64Array(M), randLon = new Float64Array(M);
for (let i = 0; i < M; i++) { randLon[i] = rnd() * 360 - 180; randLat[i] = Math.asin(rnd() * 2 - 1) * 180 / Math.PI; }
const ref = JSON.parse(fs.readFileSync('data/reference-points.json', 'utf8'));
const bLat = [], bLon = [];
for (const p of ref) if (p.kind.startsWith('border')) { bLat.push(p.lat); bLon.push(p.lon); }

function rate(tz, lats, lons) {
  const n = lats.length; let sink = 0, ops = 0, i = 0;
  for (let k = 0; k < 50000; k++) sink += len(tz.lookup(lats[k % n], lons[k % n]));
  const start = performance.now();
  do { for (let k = 0; k < 4096; k++) { sink += len(tz.lookup(lats[i], lons[i])); if (++i === n) i = 0; } ops += 4096; } while (performance.now() - start < SECONDS * 1000);
  return sink ? ops / ((performance.now() - start) / 1000) : 0;
}
const fmt = n => n.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(11);
console.log('file'.padEnd(28) + '   MB   depth bits  random ops/s  border ops/s  border ns/op');
for (const f of files) {
  const buf = fs.readFileSync(f);
  const tz = createLookup(buf);
  const r = rate(tz, randLat, randLon), b = rate(tz, bLat, bLon);
  console.log(`${f.replace('data/', '').padEnd(28)} ${(buf.length / 1e6).toFixed(2).padStart(5)}   ${String(tz.depth).padEnd(5)} ${String(buf[6] || 16).padEnd(4)} ${fmt(r)}  ${fmt(b)}  ${(1e9 / b).toFixed(0).padStart(12)}`);
}
