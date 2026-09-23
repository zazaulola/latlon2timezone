// Downloads the timezone-boundary-builder release (with oceans) into data/raw.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const RELEASE = process.argv[2] ?? '2026c';
const url = `https://github.com/evansiroky/timezone-boundary-builder/releases/download/${RELEASE}/timezones-with-oceans.geojson.zip`;
fs.mkdirSync('data/raw', { recursive: true });
console.log('downloading', url);
execFileSync('curl', ['-L', '-o', 'data/raw/timezones-with-oceans.geojson.zip', url], { stdio: 'inherit' });
execFileSync('unzip', ['-o', '-q', 'data/raw/timezones-with-oceans.geojson.zip', '-d', 'data/raw'], { stdio: 'inherit' });
// tzdb country tables, used by --countries in build.mjs
for (const f of ['zone.tab', 'zone1970.tab']) execFileSync('curl', ['-sL', '-o', 'data/raw/' + f, 'https://data.iana.org/time-zones/tzdb/' + f], { stdio: 'inherit' });
// Natural Earth 50m marine polygons (public domain), used by scripts/partition.mjs for seas/oceans
execFileSync('curl', ['-sL', '-o', 'data/raw/ne_50m_marine.geojson', 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_geography_marine_polys.geojson'], { stdio: 'inherit' });
fs.writeFileSync('data/raw/RELEASE', RELEASE + '\n');
console.log('done: data/raw/combined-with-oceans.json');
