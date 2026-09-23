// Prints a table from data/variants.log (one JSON object per line, as written by build.mjs).
import fs from 'node:fs';
const rows = [];
for (const line of fs.readFileSync(process.argv[2] ?? 'data/variants.log', 'utf8').split('\n').filter(Boolean)) {
  const j = line.indexOf('{'); if (j < 0) continue;
  try { rows.push(JSON.parse(line.slice(j))); } catch { console.log('partial:', line.slice(0, 100)); }
}
const mb = n => (n / 1e6).toFixed(2);
console.log('depth  tol      bits  verts     polyLeaves  maxLeaf  total MB  gzip MB  brotli MB  nodes MB  build s');
for (const o of rows) console.log(`${String(o.depth).padEnd(6)} ${String(o.tol).padEnd(8)} ${String(o.bits ?? 16).padEnd(5)} ${String(o.storedVerts).padStart(8)}  ${String(o.polyLeaves).padStart(10)}  ${String(o.maxLeafVerts).padStart(7)}  ${mb(o.bytes.total).padStart(8)}  ${mb(o.bytes.gzip).padStart(7)}  ${mb(o.bytes.brotli).padStart(9)}  ${mb(o.bytes.nodes).padStart(8)}  ${String(o.buildSeconds).padStart(7)}`);
