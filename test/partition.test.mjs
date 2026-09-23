// Coverage test for a partition (scripts/partition.mjs): using the tiled loader
// over a set of groups that should cover the whole world, every reference point
// must resolve to its true zone (same tolerance rule as test/reference.mjs).
//
//   node test/partition.test.mjs [--parts data/parts] [--sets "countries,seas,oceans,antarctica;continents,seas,oceans,antarctica"]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createTiledLookup } from '../src/tiled.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] ?? true] : null).filter(Boolean));
const PARTS = args.parts ?? 'data/parts';
const SETS = (args.sets ?? 'countries,seas,oceans,antarctica;continents,seas,oceans,antarctica').split(';').map(s => s.split(','));
const manifest = JSON.parse(fs.readFileSync(path.join(PARTS, 'manifest.json'), 'utf8'));
const TOL = manifest.tol, SLACK = 2e-5;
const points = JSON.parse(fs.readFileSync('data/reference-points.json', 'utf8'));
if (!points.length) throw new Error('run test/reference.mjs first to create data/reference-points.json');

let ringsOf = null; // lazily loaded source geometry for distance checks
function distToZone(tz, x, y) {
  if (!ringsOf) {
    ringsOf = new Map();
    for (const f of JSON.parse(fs.readFileSync('data/raw/combined-with-oceans.json', 'utf8')).features) {
      const pgs = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      ringsOf.set(f.properties.tzid, pgs.flat());
    }
  }
  let best = Infinity;
  for (const r of ringsOf.get(tz) ?? []) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [ax, ay] = r[j], [bx, by] = r[i]; const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
    let t = L2 ? ((x - ax) * vx + (y - ay) * vy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - ax - t * vx, dy = y - ay - t * vy; best = Math.min(best, dx * dx + dy * dy);
  }
  return Math.sqrt(best);
}

let failed = false;
for (const groups of SETS) {
  const t0 = performance.now();
  const loadedFiles = [];
  const tz = createTiledLookup({ manifest, groups, load: p => zlib.gunzipSync(fs.readFileSync(path.join(PARTS, p.file))), onLoad: p => loadedFiles.push(p.file) });
  let nulls = 0, bad = 0, maxD = 0, worst = null, candidatesSum = 0;
  const badByZone = new Map();
  for (const p of points) {
    const cands = p.refAll ?? [p.ref];
    candidatesSum += tz.candidates(p.lat, p.lon).length;
    const got = await tz.lookup(p.lat, p.lon);
    if (got === null) { nulls++; }
    if (got === null || !cands.includes(got)) {
      bad++;
      const d = Math.min(distToZone(p.ref, p.lon, p.lat), got ? distToZone(got, p.lon, p.lat) : Infinity);
      if (d > maxD) { maxD = d; worst = { ...p, got, d }; }
      if (got === null || d > TOL + SLACK) badByZone.set(`${p.ref} -> ${got}`, (badByZone.get(`${p.ref} -> ${got}`) ?? 0) + 1);
    }
  }
  const gz = tz.parts.reduce((s, p) => s + p.gzipBytes, 0);
  console.log(`groups [${groups.join(', ')}]: ${tz.parts.length} parts, ${(gz / 1e6).toFixed(2)} MB gz; loaded ${loadedFiles.length} parts for ${points.length} points in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  avg candidate parts per point: ${(candidatesSum / points.length).toFixed(2)}; null answers: ${nulls}; mismatches: ${bad}; max distance to true boundary: ${maxD.toExponential(2)} deg (~${(maxD * 111000).toFixed(1)} m)`);
  if (nulls || maxD > TOL + SLACK) {
    failed = true;
    console.log('  FAIL — uncovered or out-of-tolerance points:', [...badByZone.entries()].slice(0, 10).map(([k, v]) => `${k} x${v}`).join('; '));
    if (worst) console.log('  worst:', worst);
  } else console.log('  PASS');
}
process.exit(failed ? 1 : 0);
