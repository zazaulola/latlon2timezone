import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signedArea, clipRingToRect, pointInRing, simplifyRing } from '../src/geom.mjs';
import { latLonToTimezone, timezoneInfo, getLookup } from '../src/index.mjs';

const sq = (x0, y0, x1, y1) => Float64Array.from([x0, y0, x1, y0, x1, y1, x0, y1]); // CCW

test('signedArea sign and magnitude', () => {
  assert.equal(signedArea(sq(0, 0, 2, 3)), 6);
  assert.equal(signedArea(Float64Array.from([0, 0, 0, 3, 2, 3, 2, 0])), -6);
});

test('clipRingToRect preserves area of intersection (concave ring)', () => {
  // U-shaped concave polygon
  const u = Float64Array.from([0, 0, 6, 0, 6, 6, 4, 6, 4, 2, 2, 2, 2, 6, 0, 6]);
  const full = signedArea(u); // 36 - 8 = 28
  assert.equal(full, 28);
  const c = clipRingToRect(u, 0, 3, 6, 6);         // upper half: two legs 2x3 each = 12
  assert.ok(Math.abs(signedArea(c) - 12) < 1e-12);
  // Even-odd containment on the clipped result matches the original for interior points
  for (const [x, y] of [[1, 4], [3, 4], [5, 4], [1, 5.5], [3, 3.5]]) {
    assert.equal(pointInRing(c, x, y), pointInRing(u, x, y), `point ${x},${y}`);
  }
  assert.equal(clipRingToRect(u, 2.5, 2.5, 3.5, 5).length, 0, 'fully outside -> empty');
});

test('simplifyRing keeps shape within tolerance', () => {
  const pts = [];
  for (let i = 0; i < 100; i++) { const a = (i / 100) * 2 * Math.PI; pts.push(Math.cos(a), Math.sin(a) + (i % 2 ? 0.0005 : 0)); }
  const r = Float64Array.from(pts);
  const s = simplifyRing(r, 0.01);
  assert.ok(s.length < r.length && s.length >= 6);
  assert.ok(Math.abs(signedArea(s) - signedArea(r)) < 0.05);
});

test('lookup: known cities', () => {
  assert.equal(latLonToTimezone(55.7558, 37.6173), 'Europe/Moscow');
  assert.equal(latLonToTimezone(40.7128, -74.006), 'America/New_York');
  assert.equal(latLonToTimezone(-33.8688, 151.2093), 'Australia/Sydney');
  assert.equal(latLonToTimezone(22.5726, 88.3639), 'Asia/Kolkata');
});

test('lookup: oceans, poles, wrapping, invalid input', () => {
  assert.equal(latLonToTimezone(30, -40), 'Etc/GMT+3');
  assert.equal(latLonToTimezone(90, 0), 'Etc/GMT');
  assert.equal(latLonToTimezone(10, 180), latLonToTimezone(10, -180));
  assert.equal(latLonToTimezone(48.8566, 2.3522 + 360), 'Europe/Paris');
  assert.equal(latLonToTimezone(48.8566, 2.3522 - 720), 'Europe/Paris');
  assert.equal(latLonToTimezone(NaN, 0), null);
  assert.equal(latLonToTimezone(-95, 0), latLonToTimezone(-90, 0), 'lat clamped');
});

test('every zone id is accepted by Intl', () => {
  for (const z of getLookup().zones) assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: z }));
});

test('timezoneInfo via Intl', () => {
  const winter = timezoneInfo('Europe/Paris', new Date('2026-01-15T12:00:00Z'));
  const summer = timezoneInfo('Europe/Paris', new Date('2026-07-15T12:00:00Z'));
  assert.equal(winter.offsetMinutes, 60); assert.equal(summer.offsetMinutes, 120);
  assert.equal(timezoneInfo('Asia/Kolkata').offsetMinutes, 330);
  assert.equal(timezoneInfo('Etc/GMT+5').offsetMinutes, -300);
  assert.equal(timezoneInfo('America/St_Johns', new Date('2026-01-15T12:00:00Z')).offsetMinutes, -210);
});
