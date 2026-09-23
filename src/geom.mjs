// Geometry helpers used by the index builder and the reference test.
// Rings are flat Float64Array-like arrays [x0,y0,x1,y1,...] (closing point NOT repeated).

/** Signed area (shoelace). Positive for counter-clockwise rings. */
export function signedArea(r) {
  const n = r.length;
  let a = 0;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    a += (r[j] - r[i]) * (r[j + 1] + r[i + 1]);
  }
  return a / 2;
}

/**
 * Sutherland–Hodgman clip of a (possibly concave) ring against an axis-aligned
 * rectangle. Winding numbers of points strictly inside the rectangle are
 * preserved, so even-odd / nonzero point-in-polygon tests on the result are
 * exact for interior points. Returns a flat array (may be empty / degenerate).
 */
export function clipRingToRect(ring, x0, y0, x1, y1) {
  let cur = ring;
  cur = clipHalf(cur, 0, x0, +1); if (cur.length < 6) return EMPTY;
  cur = clipHalf(cur, 0, x1, -1); if (cur.length < 6) return EMPTY;
  cur = clipHalf(cur, 1, y0, +1); if (cur.length < 6) return EMPTY;
  cur = clipHalf(cur, 1, y1, -1); if (cur.length < 6) return EMPTY;
  return dedupe(cur);
}
const EMPTY = new Float64Array(0);

// axis: 0 = x, 1 = y. sign=+1 keeps coord >= v, sign=-1 keeps coord <= v.
function clipHalf(r, axis, v, sign) {
  const n = r.length;
  const out = [];
  let px = r[n - 2], py = r[n - 1];
  let pin = sign * ((axis ? py : px) - v) >= 0;
  for (let i = 0; i < n; i += 2) {
    const cx = r[i], cy = r[i + 1];
    const cin = sign * ((axis ? cy : cx) - v) >= 0;
    if (cin !== pin) {
      // intersection of segment p->c with the line coord=v
      if (axis === 0) {
        const t = (v - px) / (cx - px);
        out.push(v, py + t * (cy - py));
      } else {
        const t = (v - py) / (cy - py);
        out.push(px + t * (cx - px), v);
      }
    }
    if (cin) out.push(cx, cy);
    px = cx; py = cy; pin = cin;
  }
  return out;
}

function dedupe(r) {
  const out = [];
  const n = r.length;
  for (let i = 0; i < n; i += 2) {
    const m = out.length;
    if (m && out[m - 2] === r[i] && out[m - 1] === r[i + 1]) continue;
    out.push(r[i], r[i + 1]);
  }
  while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return out.length >= 6 ? Float64Array.from(out) : EMPTY;
}

/** Even-odd point-in-ring test (ray casting). */
export function pointInRing(r, x, y) {
  const n = r.length;
  let inside = false;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function ringBBox(r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    const x = r[i], y = r[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/**
 * Douglas–Peucker simplification of a closed ring with tolerance `tol`
 * (same units as coordinates). Vertices for which `isAnchor(x, y)` returns
 * true are never removed and split the ring into independently simplified
 * arcs. The builder anchors vertices lying on the quadtree cell boundary, so
 * simplification never moves the (artificial) cell edges — only the real
 * zone boundary, and by at most `tol`.
 */
export function simplifyRing(r, tol, isAnchor = null) {
  const n = r.length >> 1;
  if (tol <= 0 || n <= 4) return r;
  const keep = new Uint8Array(n);
  const anchors = [];
  if (isAnchor) for (let i = 0; i < n; i++) if (isAnchor(r[2 * i], r[2 * i + 1])) { keep[i] = 1; anchors.push(i); }
  if (anchors.length < 2) {
    // Free ring: anchor at vertex 0 and the vertex farthest from it.
    let far = 0, best = -1;
    for (let i = 1; i < n; i++) {
      const dx = r[2 * i] - r[0], dy = r[2 * i + 1] - r[1];
      const d = dx * dx + dy * dy;
      if (d > best) { best = d; far = i; }
    }
    anchors.length = 0; anchors.push(0, far); keep[0] = keep[far] = 1;
  }
  const tol2 = tol * tol;
  for (let k = 0; k < anchors.length; k++) {
    const a = anchors[k], b = k + 1 < anchors.length ? anchors[k + 1] : anchors[0] + n; // cyclic
    dpArc(r, n, keep, a, b, tol2);
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[2 * i], r[2 * i + 1]);
  return out.length >= 6 ? Float64Array.from(out) : r;
}

// Marks vertices to keep on the open arc a..b (indices taken mod n, b may exceed n).
function dpArc(r, n, keep, a0, b0, tol2) {
  const stack = [[a0, b0]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ai = a % n, bi = b % n;
    const ax = r[2 * ai], ay = r[2 * ai + 1], bx = r[2 * bi], by = r[2 * bi + 1];
    const vx = bx - ax, vy = by - ay;
    const L2 = vx * vx + vy * vy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const ii = i % n;
      const px = r[2 * ii] - ax, py = r[2 * ii + 1] - ay;
      let d;
      if (L2 === 0) d = px * px + py * py;
      else {
        let t = (px * vx + py * vy) / L2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const ex = px - t * vx, ey = py - t * vy;
        d = ex * ex + ey * ey;
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) { keep[idx % n] = 1; stack.push([a, idx], [idx, b]); }
  }
}
