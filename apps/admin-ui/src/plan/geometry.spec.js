import { describe, expect, it } from 'vitest'

import {
  angleCandidates,
  bbox,
  cellPolygon,
  centroid,
  cleanPolygon,
  columnPolygons,
  distance,
  frontEdge,
  hull,
  localToWorld,
  normalizeAngle,
  pointInPolygon,
  resizeRow,
  rowFromCorners,
  snapAngle,
  suggestRow,
  worldToLocal
} from './geometry'

const ROW = { cx: 500, cy: 300, w: 400, h: 240, angle: 0, k: 4, depth: 2, front: 'bottom' }

const sides = (polygon) => polygon.map((point, i) => distance(point, polygon[(i + 1) % polygon.length]))

describe('local ↔ world', () => {
  it('round-trips at any angle', () => {
    for (const angle of [0, 17, 90, -135, 180]) {
      const row = { ...ROW, angle }
      const [X, Y] = localToWorld(row, 37, -81)
      const [x, y] = worldToLocal(row, X, Y)

      expect(x).toBeCloseTo(37, 6)
      expect(y).toBeCloseTo(-81, 6)
    }
  })

  it('turns clockwise on screen (y points down)', () => {
    const [X, Y] = localToWorld({ ...ROW, angle: 90 }, 10, 0)

    expect(X).toBeCloseTo(500, 6)
    expect(Y).toBeCloseTo(310, 6)
  })
})

describe('row cells', () => {
  it('cuts the rectangle into K columns × depth cells of equal size', () => {
    const cell = cellPolygon(ROW, 0, 0)

    expect(sides(cell)).toEqual([100, 120, 100, 120])
  })

  it('keeps cell sizes when the row is rotated', () => {
    for (const angle of [15, 45, 90, -72]) {
      const turned = sides(cellPolygon({ ...ROW, angle }, 2, 1))

      turned.forEach((side, i) => expect(side).toBeCloseTo([100, 120, 100, 120][i], 0))
    }
  })

  it('orders a column front → back: depth 0 touches the front edge', () => {
    const [front, back] = columnPolygons(ROW, 0)

    // front = bottom: the first cell is the lower one.
    expect(centroid(front)[1]).toBeGreaterThan(centroid(back)[1])
    expect(Math.max(...front.map((p) => p[1]))).toBe(420)
  })

  it('follows the chosen front side', () => {
    const top = columnPolygons({ ...ROW, front: 'top' }, 0)
    expect(centroid(top[0])[1]).toBeLessThan(centroid(top[1])[1])

    const left = columnPolygons({ ...ROW, front: 'left', k: 2 }, 0)
    expect(centroid(left[0])[0]).toBeLessThan(centroid(left[1])[0])

    const right = columnPolygons({ ...ROW, front: 'right', k: 2 }, 0)
    expect(centroid(right[0])[0]).toBeGreaterThan(centroid(right[1])[0])
  })

  it('runs columns left → right along a horizontal row', () => {
    expect(centroid(cellPolygon(ROW, 0, 0))[0]).toBeLessThan(centroid(cellPolygon(ROW, 3, 0))[0])
  })

  it('places the front edge on the front side', () => {
    const edge = frontEdge(ROW)

    expect(edge[0][1]).toBe(420)
    expect(edge[1][1]).toBe(420)
  })
})

describe('suggestions', () => {
  it('puts lines along the long side and guesses depth from the short one', () => {
    expect(suggestRow(560, 240)).toEqual({ front: 'bottom', k: 10, depth: 2 })
    expect(suggestRow(120, 560)).toEqual({ front: 'right', k: 10, depth: 1 })
  })

  it('takes the depth from a chosen line', () => {
    expect(suggestRow(560, 120, { capacity: 3 }).depth).toBe(3)
  })

  it('builds a row from two corners in any order', () => {
    const row = rowFromCorners([300, 400], [100, 200])

    expect(row).toMatchObject({ cx: 200, cy: 300, w: 200, h: 200, angle: 0 })
  })

  it('resizes from a corner and keeps the opposite one in place', () => {
    const next = resizeRow(ROW, 'se', [800, 500])

    expect(next).toEqual({ cx: 550, cy: 340, w: 500, h: 320 })
  })
})

describe('angle snapping', () => {
  it('normalizes into (-180, 180]', () => {
    expect(normalizeAngle(270)).toBe(-90)
    expect(normalizeAngle(-190)).toBe(170)
    expect(normalizeAngle(180)).toBe(180)
  })

  it('sticks to the axes and their right angles', () => {
    expect(snapAngle(88.5).angle).toBeCloseTo(90, 6)
    expect(snapAngle(-1.4).angle).toBeCloseTo(0, 6)
    expect(snapAngle(-181.5).angle).toBeCloseTo(-180, 6)
    expect(snapAngle(45).angle).toBe(45)
  })

  it('sticks to another row and to the edge of an existing place', () => {
    const candidates = angleCandidates({
      rows: [{ id: 1, angle: 30 }, { id: 2, angle: 70 }],
      polygons: [[[0, 0], [100, 100], [0, 200]]],
      excludeRowId: 2
    })

    expect(snapAngle(31.5, { candidates })).toEqual({ angle: 30, reason: 'как ряд №1' })
    expect(snapAngle(68, { candidates }).angle).toBe(68)
    expect(snapAngle(46, { candidates }).reason).toBe('по краю места')
  })

  it('steps by 15° with Shift and does not snap with Alt', () => {
    expect(snapAngle(38, { shift: true }).angle).toBe(45)
    expect(snapAngle(1, { alt: true }).angle).toBe(1)
  })
})

describe('polygon helpers', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]]

  it('measures a bounding box', () => {
    expect(bbox([square, [[20, -5], [21, 3], [22, 4]]])).toEqual({ x0: 0, y0: -5, x1: 22, y1: 10 })
  })

  it('wraps points in a hull', () => {
    expect(hull([...square, [5, 5]])).toHaveLength(4)
  })

  it('finds the area centroid', () => {
    expect(centroid(square)).toEqual([5, 5])
    expect(centroid([[0, 0], [10, 0], [10, 10]])[0]).toBeCloseTo(20 / 3, 6)
  })

  it('tells inside from outside', () => {
    expect(pointInPolygon([5, 5], square)).toBe(true)
    expect(pointInPolygon([15, 5], square)).toBe(false)
  })

  it('accepts only polygons the API will store', () => {
    expect(cleanPolygon([[0, 0], [1, 1]])).toBeNull()
    expect(cleanPolygon([[0, 0], [1, 'x'], [2, 2]])).toBeNull()
    expect(cleanPolygon(Array.from({ length: 65 }, (_, i) => [i, i]))).toBeNull()
    expect(cleanPolygon([[0.04, 0], [1.26, 1], [2, 2]])).toEqual([[0, 0], [1.3, 1], [2, 2]])
  })
})
