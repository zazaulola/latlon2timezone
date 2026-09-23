import fs from 'node:fs';
const t0 = performance.now();
const fc = JSON.parse(fs.readFileSync('data/raw/combined-with-oceans.json', 'utf8'));
console.log('parsed in', ((performance.now()-t0)/1000).toFixed(1), 's; features:', fc.features.length);
let verts = 0, polys = 0, rings = 0, bad = [], canon = [];
const intlSet = new Set(Intl.supportedValuesOf('timeZone'));
let notInSupported = [];
for (const f of fc.features) {
  const tz = f.properties.tzid;
  const g = f.geometry;
  const pgs = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const pg of pgs) { polys++; for (const r of pg) { rings++; verts += r.length; } }
  try {
    const res = new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;
    if (res !== tz) canon.push([tz, res]);
  } catch { bad.push(tz); }
  if (!intlSet.has(tz)) notInSupported.push(tz);
}
console.log({ polys, rings, verts });
console.log('rejected by Intl.DateTimeFormat:', bad);
console.log('canonicalized differently by Intl:', canon);
console.log('not in Intl.supportedValuesOf (count):', notInSupported.length, notInSupported.slice(0, 40));
const big = fc.features.map(f => { const g=f.geometry; const pgs = g.type==='Polygon'?[g.coordinates]:g.coordinates; let n=0; for (const pg of pgs) for (const r of pg) n+=r.length; return [f.properties.tzid, n]; }).sort((a,b)=>b[1]-a[1]).slice(0,8);
console.log('largest features:', big);
