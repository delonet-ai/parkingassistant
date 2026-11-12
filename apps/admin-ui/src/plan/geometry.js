// Plan geometry: the pure math behind the floor-plan surface and the markup editor.
//
// Everything is in image pixels of the floor plan, origin top-left — the same coordinates the
// API stores (`places[placeId].polygon`). No DOM, no Vue, no parking rule: which place is
// free is the API's business; this module only knows rectangles, rotations and polygons.
//
// A *row* is the editor's helper for a run of parking lines standing side by side:
//   { cx, cy, w, h, angle, k, depth, front }
// — a rectangle centred at (cx, cy), w×h before rotation, turned by `angle` degrees clockwise
// (screen y points down), cut into `k` columns (one per line) × `depth` cells (one per car in
// the line). `front` is the side the cars leave by, named before rotation: top | bottom | left
// | right. Cell depth 0 is always the one at the front edge, so a line's slot at position 1
// (front) gets depth 0, position 2 gets depth 1, and so on.

export const FRONT_SIDES = ['top', 'right', 'bottom', 'left']

// Rough size of one stall on the 3504 px G4 scan, used only to *suggest* K and the depth
// for a freshly drawn rectangle. The operator corrects both before cutting.
export const STALL_WIDTH = 56
export const STALL_LENGTH = 120
export const REFERENCE_IMAGE_WIDTH = 3504

export const round1 = (value) => Math.round(value * 10) / 10
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const rad = (degrees) => (degrees * Math.PI) / 180

/** An angle folded into (-180, 180]. */
export function normalizeAngle(angle) {
  const folded = ((angle % 360) + 360) % 360

  return folded > 180 ? folded - 360 : folded
}

/** Row-local (centre-origin, unrotated) → image coordinates. */
export function localToWorld(row, x, y) {
  const a = rad(row.angle || 0)
  const c = Math.cos(a)
  const s = Math.sin(a)

  return [row.cx + x * c - y * s, row.cy + x * s + y * c]
}

/** Image coordinates → row-local. Inverse of `localToWorld`. */
export function worldToLocal(row, X, Y) {
  const a = rad(row.angle || 0)
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dx = X - row.cx
  const dy = Y - row.cy

  return [dx * c + dy * s, -dx * s + dy * c]
}

/** Columns run along the long axis: left→right when the front is top/bottom, else top→bottom. */
export const isHorizontal = (row) => row.front === 'top' || row.front === 'bottom'

/** One cell as a local box [x0, y0, x1, y1]; `depth` 0 touches the front edge. */
export function cellLocal(row, column, depth) {
  if (isHorizontal(row)) {
    const cw = row.w / row.k
    const dh = row.h / row.depth
    const x0 = -row.w / 2 + column * cw
    const y0 = row.front === 'top' ? -row.h / 2 + depth * dh : row.h / 2 - (depth + 1) * dh

    return [x0, y0, x0 + cw, y0 + dh]
  }

  const ch = row.h / row.k
  const dw = row.w / row.depth
  const y0 = -row.h / 2 + column * ch
  const x0 = row.front === 'left' ? -row.w / 2 + depth * dw : row.w / 2 - (depth + 1) * dw

  return [x0, y0, x0 + dw, y0 + ch]
}

function boxPolygon(row, [x0, y0, x1, y1]) {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1]
  ].map(([x, y]) => localToWorld(row, x, y).map(round1))
}

export const cellPolygon = (row, column, depth) => boxPolygon(row, cellLocal(row, column, depth))

export const rowPolygon = (row) => boxPolygon(row, [-row.w / 2, -row.h / 2, row.w / 2, row.h / 2])

/** The polygons of one column, front → back: index i is the slot at position i + 1. */
export function columnPolygons(row, column) {
  return Array.from({ length: row.depth }, (_, depth) => cellPolygon(row, column, depth))
}

/** The front edge as two image points. */
export function frontEdge(row) {
  const w = row.w / 2
  const h = row.h / 2
  const edge = {
    top: [[-w, -h], [w, -h]],
    bottom: [[-w, h], [w, h]],
    left: [[-w, -h], [-w, h]],
    right: [[w, -h], [w, h]]
  }[row.front]

  return edge.map(([x, y]) => localToWorld(row, x, y))
}

/**
 * K, depth and front for an axis-aligned rectangle the operator just dragged out.
 * The long side carries the lines; `capacity`, when a line is already chosen, decides depth.
 */
export function suggestRow(width, height, { capacity = null, scale = 1 } = {}) {
  const horizontal = width >= height
  const along = horizontal ? width : height
  const across = horizontal ? height : width

  return {
    front: horizontal ? 'bottom' : 'right',
    k: Math.max(1, Math.round(along / (STALL_WIDTH * scale))),
    depth: capacity ? clamp(capacity, 1, 3) : clamp(Math.round(across / (STALL_LENGTH * scale)), 1, 3)
  }
}

/** K that fits the row's current length. */
export function suggestK(row, scale = 1) {
  return clamp(Math.round((isHorizontal(row) ? row.w : row.h) / (STALL_WIDTH * scale)) || 1, 1, 80)
}

/** A row from two opposite corners of an axis-aligned drag. */
export function rowFromCorners(a, b, options = {}) {
  const x0 = Math.min(a[0], b[0])
  const x1 = Math.max(a[0], b[0])
  const y0 = Math.min(a[1], b[1])
  const y1 = Math.max(a[1], b[1])
  const w = x1 - x0
  const h = y1 - y0

  return {
    cx: round1((x0 + x1) / 2),
    cy: round1((y0 + y1) / 2),
    w: round1(w),
    h: round1(h),
    angle: 0,
    ...suggestRow(w, h, options)
  }
}

export function rectPolygon(a, b) {
  const x0 = Math.min(a[0], b[0])
  const x1 = Math.max(a[0], b[0])
  const y0 = Math.min(a[1], b[1])
  const y1 = Math.max(a[1], b[1])

  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1]
  ].map((point) => point.map(round1))
}

// Resize handles, by the sign of the local axis they pull on.
export const HANDLES = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0]
}

/** New centre and size when `handle` of `original` is dragged to the image point `point`. */
export function resizeRow(original, handle, point, minSize = 8) {
  const [sx, sy] = HANDLES[handle]
  const [lx, ly] = worldToLocal(original, point[0], point[1])
  let x0 = -original.w / 2
  let x1 = original.w / 2
  let y0 = -original.h / 2
  let y1 = original.h / 2

  if (sx < 0) x0 = Math.min(lx, x1 - minSize)
  if (sx > 0) x1 = Math.max(lx, x0 + minSize)
  if (sy < 0) y0 = Math.min(ly, y1 - minSize)
  if (sy > 0) y1 = Math.max(ly, y0 + minSize)

  const centre = localToWorld(original, (x0 + x1) / 2, (y0 + y1) / 2)

  return { cx: round1(centre[0]), cy: round1(centre[1]), w: round1(x1 - x0), h: round1(y1 - y0) }
}

/** Angle of the rotation handle when dragged to `point`: 0 straight above the centre. */
export function rotationAt(row, point) {
  return (Math.atan2(point[0] - row.cx, -(point[1] - row.cy)) * 180) / Math.PI
}

export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

/**
 * Angles a rotating row is drawn to: the axes, other rows, and the edges of places already on
 * the plan (each modulo 90°). Short edges are ignored — they say nothing about a direction.
 */
export function angleCandidates({ rows = [], polygons = [], excludeRowId = null, minEdge = 20 } = {}) {
  const candidates = [{ angle: 0, reason: 'ось' }]

  for (const row of rows) {
    if (row.id !== excludeRowId) {
      candidates.push({ angle: row.angle, reason: `как ряд №${row.id}` })
    }
  }

  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i += 1) {
      const p = polygon[i]
      const q = polygon[(i + 1) % polygon.length]

      if (distance(p, q) >= minEdge) {
        candidates.push({ angle: (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI, reason: 'по краю места' })
      }
    }
  }

  return candidates
}

/**
 * Snap a free angle. `alt` turns snapping off, `shift` steps by 15°, otherwise the nearest
 * candidate (± multiples of 90°) within `threshold` degrees wins.
 */
export function snapAngle(angle, { candidates = [{ angle: 0, reason: 'ось' }], shift = false, alt = false, threshold = 3 } = {}) {
  if (alt) {
    return { angle, reason: '' }
  }

  if (shift) {
    return { angle: Math.round(angle / 15) * 15, reason: '' }
  }

  let best = null

  for (const candidate of candidates) {
    for (let turn = -2; turn <= 2; turn += 1) {
      const target = candidate.angle + turn * 90
      const delta = Math.abs(normalizeAngle(angle - target))

      if (delta < threshold && (!best || delta < best.delta)) {
        best = { delta, angle: angle - normalizeAngle(angle - target), reason: candidate.reason }
      }
    }
  }

  return best ? { angle: best.angle, reason: best.reason } : { angle, reason: '' }
}

export function bbox(polygons) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity

  for (const polygon of polygons) {
    for (const [x, y] of polygon) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }

  return { x0, y0, x1, y1 }
}

/** Convex hull (monotone chain), counter-clockwise in screen terms. */
export function hull(points) {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])

  if (sorted.length < 3) {
    return sorted
  }

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  const upper = []

  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop()
    lower.push(point)
  }

  for (const point of sorted.slice().reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop()
    upper.push(point)
  }

  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/** Area centroid; the vertex mean for a degenerate (zero-area) polygon. */
export function centroid(polygon) {
  let area = 0
  let cx = 0
  let cy = 0

  for (let i = 0; i < polygon.length; i += 1) {
    const [x0, y0] = polygon[i]
    const [x1, y1] = polygon[(i + 1) % polygon.length]
    const f = x0 * y1 - x1 * y0

    area += f
    cx += (x0 + x1) * f
    cy += (y0 + y1) * f
  }

  if (Math.abs(area) < 1e-9) {
    const n = polygon.length || 1

    return [polygon.reduce((s, p) => s + p[0], 0) / n, polygon.reduce((s, p) => s + p[1], 0) / n]
  }

  return [cx / (3 * area), cy / (3 * area)]
}

/** Ray casting; a point exactly on an edge may land either way. */
export function pointInPolygon(point, polygon) {
  const [x, y] = point
  let inside = false

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]

    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }

  return inside
}

export const translatePolygon = (polygon, dx, dy) => polygon.map(([x, y]) => [round1(x + dx), round1(y + dy)])

/** A label size that fits the place: limited by its short side and by the code's length. */
export function labelFontSize(polygon, code) {
  const e1 = distance(polygon[0], polygon[1])
  const e2 = distance(polygon[1], polygon[2] || polygon[0])
  const length = Math.max(String(code || '?').length, 1)

  return round1(clamp(Math.min(Math.min(e1, e2) * 0.45, Math.max(e1, e2) / (length * 0.62)), 6, 30))
}

export const pointsAttr = (polygon) => polygon.map((point) => point.join(',')).join(' ')

/** A polygon the API will accept: 3..64 finite points, rounded to 0.1 px. */
export function cleanPolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 64) {
    return null
  }

  const points = []

  for (const point of polygon) {
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(+point[0]) || !Number.isFinite(+point[1])) {
      return null
    }
    points.push([round1(+point[0]), round1(+point[1])])
  }

  return points
}
