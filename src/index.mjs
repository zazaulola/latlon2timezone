// Node entry point: loads the bundled compressed index synchronously on first use.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createLookup } from './lookup.mjs';
import { createTiledLookup } from './tiled.mjs';
export { createLookup, createTiledLookup };

let instance = null;
function get() {
  if (!instance) {
    const dir = fileURLToPath(new URL('../data/', import.meta.url));
    const raw = fs.existsSync(dir + 'tz.bin') ? fs.readFileSync(dir + 'tz.bin') : zlib.gunzipSync(fs.readFileSync(dir + 'tz.bin.gz'));
    instance = createLookup(raw);
  }
  return instance;
}

/**
 * Load a specific index file (e.g. a regional build made with
 * `node scripts/build.mjs --countries US,CA,MX --out data/tz-na.bin`).
 * Accepts .bin or .bin.gz. Returns { lookup(lat, lon), zones, depth, bytes }.
 */
export function createLookupFromFile(path) {
  const raw = fs.readFileSync(path);
  return createLookup(path.endsWith('.gz') ? zlib.gunzipSync(raw) : raw);
}

/**
 * Tiled lookup over a partition directory produced by scripts/partition.mjs
 * (reads <dir>/manifest.json, gunzips parts from disk on demand).
 *   const tz = tiledLookupFromDir('data/parts', ['countries', 'seas', 'oceans', 'antarctica']);
 *   await tz.lookup(55.75, 37.62);
 */
export function tiledLookupFromDir(dir, groups) {
  const manifest = JSON.parse(fs.readFileSync(dir + '/manifest.json', 'utf8'));
  return createTiledLookup({ manifest, groups, load: p => zlib.gunzipSync(fs.readFileSync(dir + '/' + p.file)) });
}

/** IANA time zone id for a coordinate, e.g. latLonToTimezone(48.8566, 2.3522) === 'Europe/Paris'. */
export function latLonToTimezone(lat, lon) { return get().lookup(lat, lon); }

/** Underlying lookup instance (zones list, build meta, depth, byte size). */
export function getLookup() { return get(); }

/**
 * Zone details via Intl for a given instant.
 * @returns {{ timeZone: string, offsetMinutes: number, offset: string, abbreviation: string, longName: string, localTime: string }}
 */
export function timezoneInfo(timeZone, date = new Date()) {
  const parts = kind => new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: kind }).formatToParts(date).find(p => p.type === 'timeZoneName').value;
  const offset = parts('longOffset');                        // 'GMT+05:30' | 'GMT'
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(offset);
  const offsetMinutes = m && m[1] ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
  const localTime = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'medium' }).format(date);
  return { timeZone, offsetMinutes, offset, abbreviation: parts('short'), longName: parts('long'), localTime };
}

/** Convenience: zone id + Intl details for a coordinate. */
export function lookupWithInfo(lat, lon, date = new Date()) {
  const tz = latLonToTimezone(lat, lon);
  return tz ? timezoneInfo(tz, date) : null;
}
