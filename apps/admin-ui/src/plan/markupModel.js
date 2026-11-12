// The markup editor's model, kept apart from the component so its rules can be read and
// tested without a pointer.
//
//   model = { places: { [placeId]: { polygon } }, rows: [row], rowSeq }
//
// `places` is what the API stores. `rows` (and `rowSeq`) travel in the API's opaque `editor`
// field, so a row survives a reload and stays re-cuttable. A *cut* row has `cols[i]` — the
// lineId bound to column i, or null — and owns the polygons of every bound line: moving,
// resizing or rotating it re-cuts those places at once.
//
// No parking rule lives here. "A line of 2 goes into a column of depth 2" is geometry: a
// line has as many slots as it has cars, and a column has as many cells as the row is deep.

import { cellPolygon, cleanPolygon, columnPolygons, round1 } from './geometry'

export const EDITOR_VERSION = 1

const sortedSlots = (line) => (line.slots || []).slice().sort((a, b) => a.position - b.position)

export const lineLabel = (line) => sortedSlots(line).map((slot) => slot.code).join('·')

export const placedCount = (model, line) => (line.slots || []).filter((slot) => model.places[slot.placeId]).length

export const rowOfLine = (model, lineId) => model.rows.find((row) => row.cut && row.cols.includes(lineId)) || null

export function isPlaceInRow(model, lineId) {
  return Boolean(rowOfLine(model, lineId))
}

/** Rebuild the polygons of every line bound to a cut row. */
export function applyRow(model, row, lineById) {
  if (!row.cut) {
    return
  }

  row.cols.forEach((lineId, column) => {
    const line = lineId && lineById[lineId]

    if (!line) {
      row.cols[column] = null
      return
    }

    const polygons = columnPolygons(row, column)
    sortedSlots(line).forEach((slot, depth) => {
      if (polygons[depth]) {
        model.places[slot.placeId] = { polygon: polygons[depth] }
      }
    })
  })
}

/** Remove a line from any row and drop its polygons. */
export function unbindLine(model, lineId, lineById) {
  for (const row of model.rows) {
    const index = row.cols.indexOf(lineId)
    if (index >= 0) row.cols[index] = null
  }

  for (const slot of lineById[lineId]?.slots || []) {
    delete model.places[slot.placeId]
  }
}

/**
 * Put a line into column `column` of a cut row. Returns `{ ok, error }`; a line whose capacity
 * differs from the row's depth does not fit.
 */
export function bindLine(model, row, column, lineId, lineById) {
  const line = lineById[lineId]

  if (!line) {
    return { ok: false, error: 'Линия не найдена на этом этаже.' }
  }

  if (line.capacity !== row.depth) {
    return {
      ok: false,
      error: `Линия ${lineLabel(line)} на ${line.capacity} маш., а ряд глубиной ${row.depth} — не подходит.`
    }
  }

  if (row.cols[column] === lineId) {
    return { ok: false, error: null }
  }

  if (row.cols[column]) {
    unbindLine(model, row.cols[column], lineById)
  }

  unbindLine(model, lineId, lineById)
  row.cols[column] = lineId
  applyRow(model, row, lineById)

  return { ok: true, error: null }
}

export function cutRow(row) {
  row.cut = true
  row.cols = Array(row.k).fill(null)
}

export function setK(model, row, k, lineById) {
  const next = Math.min(80, Math.max(1, Math.round(k) || 1))

  if (row.cut) {
    row.cols.slice(next).forEach((lineId) => lineId && unbindLine(model, lineId, lineById))
    row.cols.length = Math.min(row.cols.length, next)
    while (row.cols.length < next) row.cols.push(null)
  }

  row.k = next
  applyRow(model, row, lineById)
}

/** Changing the depth unbinds every line in the row: none of them fits any more. */
export function setDepth(model, row, depth, lineById) {
  row.cols.forEach((lineId) => lineId && unbindLine(model, lineId, lineById))
  row.depth = depth
}

export function deleteRow(model, row, lineById) {
  row.cols.forEach((lineId) => lineId && unbindLine(model, lineId, lineById))
  model.rows = model.rows.filter((candidate) => candidate !== row)
}

export function addRow(model, geometry) {
  const row = { id: model.rowSeq, cut: false, cols: [], ...geometry }
  model.rowSeq += 1
  model.rows.push(row)

  return row
}

/** A copy of the row next to it (on the back side), uncut columns emptied. */
export function duplicateRow(model, row) {
  const along = row.front === 'top' || row.front === 'bottom'
  const offset = along ? [0, row.h + 6] : [row.w + 6, 0]
  const a = (row.angle * Math.PI) / 180
  const copy = {
    ...row,
    id: model.rowSeq,
    cx: round1(row.cx + offset[0] * Math.cos(a) - offset[1] * Math.sin(a)),
    cy: round1(row.cy + offset[0] * Math.sin(a) + offset[1] * Math.cos(a)),
    cols: row.cut ? Array(row.k).fill(null) : []
  }

  model.rowSeq += 1
  model.rows.push(copy)

  return copy
}

/**
 * «Раздать по порядку»: the unplaced lines of the row's depth fill its empty columns in list
 * order, starting from `startLineId` when given. Returns how many were bound and how many
 * columns stayed empty.
 */
export function distribute(model, row, lines, lineById, startLineId = null) {
  const empty = row.cols.map((lineId, index) => (lineId ? -1 : index)).filter((index) => index >= 0)
  let pool = lines.filter((line) => line.capacity === row.depth && placedCount(model, line) === 0)
  const start = startLineId ? pool.findIndex((line) => line.lineId === startLineId) : -1

  if (start > 0) {
    pool = pool.slice(start)
  }

  let bound = 0
  for (const column of empty) {
    const line = pool.shift()
    if (!line) break
    bindLine(model, row, column, line.lineId, lineById)
    bound += 1
  }

  return { bound, emptyColumns: empty.length - bound }
}

/** The next unplaced line after `afterLineId` (wrapping), optionally of one capacity. */
export function nextUnplaced(model, lines, afterLineId, capacity = null) {
  const index = afterLineId ? lines.findIndex((line) => line.lineId === afterLineId) : -1
  const order = lines.slice(index + 1).concat(lines.slice(0, index + 1))

  return (
    order.find(
      (line) =>
        line.lineId !== afterLineId &&
        placedCount(model, line) < line.capacity &&
        (!capacity || line.capacity === capacity)
    ) || null
  )
}

export const nextSlot = (model, line) => sortedSlots(line).find((slot) => !model.places[slot.placeId]) || null

/** Rows from the opaque `editor` blob, minus anything malformed and lines no longer here. */
export function readEditor(editor, lineById) {
  const source = editor && typeof editor === 'object' ? editor : {}
  const rows = (Array.isArray(source.rows) ? source.rows : [])
    .filter(
      (row) =>
        row &&
        [row.cx, row.cy, row.w, row.h, row.angle].every(Number.isFinite) &&
        row.w > 0 &&
        row.h > 0 &&
        row.k >= 1 &&
        row.depth >= 1 &&
        row.depth <= 3 &&
        ['top', 'bottom', 'left', 'right'].includes(row.front)
    )
    .map((row) => {
      const cols = row.cut ? (Array.isArray(row.cols) ? row.cols : []).slice(0, row.k) : []
      while (row.cut && cols.length < row.k) cols.push(null)

      return {
        id: Number(row.id) || 0,
        cx: row.cx,
        cy: row.cy,
        w: row.w,
        h: row.h,
        angle: row.angle,
        k: row.k,
        depth: row.depth,
        front: row.front,
        cut: Boolean(row.cut),
        cols: cols.map((lineId) => (lineId && lineById[lineId] ? lineId : null))
      }
    })
  const maxId = rows.reduce((max, row) => Math.max(max, row.id), 0)

  return { rows, rowSeq: Math.max(Number(source.rowSeq) || 1, maxId + 1) }
}

/** The model a markup answer describes. Unusable polygons are dropped. */
export function modelFromMarkup(markup, lineById) {
  const places = {}

  for (const [placeId, value] of Object.entries((markup && markup.places) || {})) {
    const polygon = cleanPolygon(value && value.polygon)
    if (polygon) places[placeId] = { polygon }
  }

  return { places, ...readEditor(markup && markup.editor, lineById) }
}

/** What `editor` holds when saved. */
export function editorBlob(model) {
  return { version: EDITOR_VERSION, rowSeq: model.rowSeq, rows: model.rows }
}

/** Cell polygons of a row (for drawing), column-major. */
export function rowCells(row) {
  const cells = []

  for (let column = 0; column < row.k; column += 1) {
    for (let depth = 0; depth < row.depth; depth += 1) {
      cells.push({ column, depth, polygon: cellPolygon(row, column, depth) })
    }
  }

  return cells
}
