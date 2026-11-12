<script setup>
// The plan markup editor (Места tab). A port of the prototype the product owner chose
// (prototypes/map/svg-rows): drag a rectangle over a run of places → K lines × depth → turn it
// → «Нарезать» → bind the floor's lines to its columns. Cut rows stay editable and re-cut
// their places live. «Место» and «Полигон» draw one free-standing place; a selected free
// place shows vertex handles that can be dragged.
//
// What is saved is `places` (polygons in plan-image pixels) plus the rows in the API's opaque
// `editor` field. No parking rule is evaluated here: which line exists and how many cars it
// takes is the inventory's answer.
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ViAlert, ViButton, ViChip, ViInput, ViText } from '@vi-frontend/vision-ui'

import PlanSurface from '../plan/PlanSurface.vue'
import {
  HANDLES,
  REFERENCE_IMAGE_WIDTH,
  angleCandidates,
  bbox,
  centroid,
  clamp,
  distance,
  frontEdge,
  hull,
  labelFontSize,
  localToWorld,
  normalizeAngle,
  pointsAttr,
  rectPolygon,
  resizeRow,
  rotationAt,
  round1,
  rowFromCorners,
  rowPolygon,
  cellLocal,
  snapAngle,
  suggestK,
  translatePolygon
} from '../plan/geometry'
import {
  addRow,
  applyRow,
  bindLine,
  cutRow,
  deleteRow,
  distribute,
  duplicateRow,
  editorBlob,
  lineLabel,
  modelFromMarkup,
  nextSlot,
  nextUnplaced,
  placedCount,
  rowCells,
  rowOfLine,
  setDepth,
  setK,
  unbindLine
} from '../plan/markupModel'
import { planImageSrc } from '../maps'
import { CAPACITY_LABELS } from '../statuses'
import { currentFloor, loadMarkup, saveMarkup, state } from '../store'

const TOOLS = [
  { value: 'select', title: 'Выбор', key: 'v' },
  { value: 'row', title: 'Ряд', key: 'r' },
  { value: 'rect', title: 'Место', key: 'm' },
  { value: 'poly', title: 'Полигон', key: 'p' }
]
const FRONTS = [
  { value: 'top', title: 'сверху' },
  { value: 'bottom', title: 'снизу' },
  { value: 'left', title: 'слева' },
  { value: 'right', title: 'справа' }
]

const root = ref(null)
const surface = ref(null)

// ---------- inventory of the floor (the API's) ----------
const lines = computed(() =>
  state.lines.filter((line) => String(line.floorLabel || '') === currentFloor().floorLabel)
)
const lineById = computed(() => Object.fromEntries(lines.value.map((line) => [line.lineId, line])))
const slotById = computed(() => {
  const index = new Map()
  for (const line of lines.value) for (const slot of line.slots || []) index.set(slot.placeId, { slot, line })
  return index
})
const totalSlots = computed(() => lines.value.reduce((sum, line) => sum + (line.slots || []).length, 0))

const planSrc = computed(() => planImageSrc(state.maps.find((map) => map.code === state.floorCode)))
const markup = computed(() =>
  state.markup && (!state.markup.mapCode || state.markup.mapCode === state.floorCode) ? state.markup : null
)

// ---------- editor model ----------
const model = reactive({ places: {}, rows: [], rowSeq: 1 })
const loaded = reactive({ mapCode: null, revision: null, baseline: '' })
const natural = reactive({ width: null, height: null })
const imageWidth = computed(() => markup.value?.imageWidth || natural.width || null)
const imageHeight = computed(() => markup.value?.imageHeight || natural.height || null)
const scale = computed(() => (imageWidth.value ? imageWidth.value / REFERENCE_IMAGE_WIDTH : 1))

const tool = ref('select')
const selRowId = ref(null)
const selLineId = ref(null)
const selPlaceId = ref(null)
const activeLineId = ref(null)
const listFilter = reactive({ unplaced: false, depth: 0 })
const undoStack = ref([])
const drawPreview = ref(null)
const polyPoints = ref([])
const mouse = ref(null)
const rotInfo = ref('')
const message = ref('')
const busy = ref(false)

/** Stable text of what a save would send — the dirty check compares it with what was loaded. */
function serialize() {
  const places = {}
  for (const key of Object.keys(model.places).sort()) places[key] = model.places[key].polygon
  return JSON.stringify({ places, editor: editorBlob(model) })
}

const dirty = computed(() => serialize() !== loaded.baseline)

watch(dirty, (value) => {
  state.markupDirty = value
})

function clearSelection() {
  selRowId.value = null
  selLineId.value = null
  selPlaceId.value = null
}

function reset() {
  const next = modelFromMarkup(markup.value, lineById.value)
  model.places = next.places
  model.rows = next.rows
  model.rowSeq = next.rowSeq
  loaded.mapCode = state.floorCode
  loaded.revision = markup.value ? markup.value.revision ?? null : null
  loaded.baseline = serialize()
  undoStack.value = []
  polyPoints.value = []
  drawPreview.value = null
  activeLineId.value = null
  clearSelection()
  state.markupDirty = false
}

// A reload of the day hands over a fresh markup object: take it unless it would throw away
// edits on the same floor (a floor switch has already asked).
watch(
  () => [state.floorCode, state.markup],
  () => {
    if (dirty.value && loaded.mapCode === state.floorCode) return
    natural.width = null
    natural.height = null
    reset()
  },
  { immediate: true }
)

// ---------- derived ----------
const row = computed(() => model.rows.find((candidate) => candidate.id === selRowId.value) || null)
const activeLine = computed(() => (activeLineId.value && lineById.value[activeLineId.value]) || null)
const selLine = computed(() => (selLineId.value && lineById.value[selLineId.value]) || null)
const placedTotal = computed(() => Object.keys(model.places).filter((id) => slotById.value.has(id)).length)
const unknownPlaces = computed(() => Object.keys(model.places).filter((id) => !slotById.value.has(id)))
const unplacedLines = computed(() => lines.value.filter((line) => placedCount(model, line) < line.capacity).length)

const listed = computed(() =>
  lines.value
    .filter((line) => !listFilter.unplaced || placedCount(model, line) < line.capacity)
    .filter((line) => !listFilter.depth || line.capacity === listFilter.depth)
    .map((line) => {
      const n = placedCount(model, line)
      return {
        line,
        n,
        state: n === 0 ? 'unplaced' : n < line.capacity ? 'partial' : 'placed'
      }
    })
)

const drawnPlaces = computed(() =>
  Object.entries(model.places).map(([placeId, { polygon }]) => {
    const info = slotById.value.get(placeId)
    const [x, y] = centroid(polygon)
    const code = info ? info.slot.code : '?'
    return {
      placeId,
      code,
      known: Boolean(info),
      points: pointsAttr(polygon),
      selected: (info && info.line.lineId === selLineId.value) || placeId === selPlaceId.value,
      label: { x: round1(x), y: round1(y), size: labelFontSize(polygon, code) }
    }
  })
)

const outlines = computed(() =>
  lines.value
    .filter((line) => line.capacity > 1)
    .map((line) => ({ line, polygons: line.slots.filter((s) => model.places[s.placeId]).map((s) => model.places[s.placeId].polygon) }))
    .filter((entry) => entry.polygons.length > 1)
    .map((entry) => ({ lineId: entry.line.lineId, points: pointsAttr(hull(entry.polygons.flat())) }))
)

const drawnRows = computed(() =>
  model.rows.map((r) => {
    const cellClass = (column) => {
      if (!r.cut || !activeLine.value || r.cols[column]) return ''
      return activeLine.value.capacity === r.depth ? 'plan-editor__cell--ok' : 'plan-editor__cell--no'
    }
    const numbers = []
    for (let column = 0; column < r.k; column += 1) {
      if (r.cut && r.cols[column]) continue
      const [x0, y0, x1, y1] = cellLocal(r, column, 0)
      const [x, y] = localToWorld(r, (x0 + x1) / 2, (y0 + y1) / 2)
      numbers.push({ column, x: round1(x), y: round1(y), size: clamp(Math.min(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 0.45, 8, 30) })
    }
    return {
      row: r,
      body: pointsAttr(rowPolygon(r)),
      cells: rowCells(r).map((cell) => ({ ...cell, points: pointsAttr(cell.polygon), cls: cellClass(cell.column) })),
      front: frontEdge(r),
      numbers
    }
  })
)

/** The free-standing place whose vertices can be dragged: selected and not owned by a row. */
const vertexPlace = computed(() => {
  const id = selPlaceId.value
  if (!id || !model.places[id] || tool.value !== 'select') return null
  const info = slotById.value.get(id)
  if (info && rowOfLine(model, info.line.lineId)) return null
  return { placeId: id, polygon: model.places[id].polygon }
})

const hint = computed(() => {
  if (tool.value === 'row') return 'Протяните рамку поверх ряда мест. Затем справа: K, глубина, перёд; круглая ручка — поворот (Shift — шаг 15°, Alt — без прилипания).'
  if (tool.value === 'rect') return activeLine.value ? `Протяните прямоугольник для места ${nextSlot(model, activeLine.value)?.code || ''} (линия ${lineLabel(activeLine.value)}).` : 'Сначала выберите линию в списке слева — прямоугольник станет её следующим местом.'
  if (tool.value === 'poly') return activeLine.value ? `Полигон для места ${nextSlot(model, activeLine.value)?.code || ''}: клики — вершины; клик в первую точку, двойной клик или Enter — замкнуть; Esc — отмена.` : 'Сначала выберите линию в списке слева.'
  if (activeLine.value) return `Кладём ${lineLabel(activeLine.value)}: кликните зелёный столбец нарезанного ряда. Esc — отменить выбор.`
  return 'Клик — выбрать ряд или место, перетаскивание — двигать, по пустому — панорама. У выбранного отдельного места тащите вершины.'
})

// ---------- undo / feedback ----------
function snapshot() {
  undoStack.value.push(JSON.stringify({ places: model.places, rows: model.rows, rowSeq: model.rowSeq }))
  if (undoStack.value.length > 80) undoStack.value.shift()
}

function undo() {
  const last = undoStack.value.pop()
  if (!last) {
    say('Отменять нечего')
    return
  }
  const previous = JSON.parse(last)
  model.places = previous.places
  model.rows = previous.rows
  model.rowSeq = previous.rowSeq
  if (selRowId.value && !row.value) selRowId.value = null
  if (selPlaceId.value && !model.places[selPlaceId.value]) selPlaceId.value = null
  polyPoints.value = []
  say('Отменено')
}

let messageTimer = null
function say(text) {
  message.value = text
  clearTimeout(messageTimer)
  messageTimer = setTimeout(() => {
    message.value = ''
  }, 3500)
}

// ---------- actions ----------
function setTool(value) {
  tool.value = value
  polyPoints.value = []
  drawPreview.value = null
}

function advanceActive(line) {
  const next = nextUnplaced(model, lines.value, line.lineId, line.capacity)
  activeLineId.value = next ? next.lineId : null
  say(`Линия ${lineLabel(line)} привязана` + (next ? `. Следующая: ${lineLabel(next)}` : ''))
}

function bindColumn(r, column) {
  if (!activeLine.value) {
    say('Выберите линию в списке слева')
    return
  }
  const line = activeLine.value
  snapshot()
  const result = bindLine(model, r, column, line.lineId, lineById.value)
  if (result.ok) {
    advanceActive(line)
    selRowId.value = r.id
  } else {
    undoStack.value.pop()
    if (result.error) say(result.error)
  }
}

function onListClick(line) {
  if (placedCount(model, line) === line.capacity) {
    activeLineId.value = null
    selectLine(line.lineId, true)
    return
  }
  activeLineId.value = activeLineId.value === line.lineId ? null : line.lineId
}

function selectLine(lineId, zoom = false) {
  selLineId.value = lineId
  selPlaceId.value = null
  const r = rowOfLine(model, lineId)
  selRowId.value = r ? r.id : null
  const polygons = (lineById.value[lineId]?.slots || []).filter((s) => model.places[s.placeId]).map((s) => model.places[s.placeId].polygon)
  if (zoom && polygons.length) surface.value?.zoomToBox(bbox(polygons), 450)
}

function placePolygon(polygon) {
  const line = activeLine.value
  const slot = line && nextSlot(model, line)
  if (!slot) {
    say('Сначала выберите в списке слева линию, у которой есть неразмеченные места')
    return
  }
  snapshot()
  model.places[slot.placeId] = { polygon: polygon.map((point) => point.map(round1)) }
  selLineId.value = line.lineId
  selPlaceId.value = slot.placeId
  selRowId.value = null
  if (!nextSlot(model, line)) {
    const next = nextUnplaced(model, lines.value, line.lineId)
    activeLineId.value = next ? next.lineId : null
  }
  say(`Место ${slot.code} размечено`)
}

function finishPoly() {
  if (polyPoints.value.length < 3) {
    say('Нужно хотя бы 3 вершины')
    return
  }
  const points = polyPoints.value
  polyPoints.value = []
  placePolygon(points)
}

function polyClick(point) {
  if (!activeLine.value) {
    say('Сначала выберите линию в списке слева')
    return
  }
  const px = surface.value?.px || 1
  if (polyPoints.value.length >= 3 && distance(point, polyPoints.value[0]) < 10 * px) {
    finishPoly()
    return
  }
  if (polyPoints.value.length >= 64) {
    say('Не больше 64 вершин')
    return
  }
  polyPoints.value = [...polyPoints.value, point.map(round1)]
}

function unbind(lineId) {
  snapshot()
  unbindLine(model, lineId, lineById.value)
  if (selLineId.value === lineId) {
    selLineId.value = null
    selPlaceId.value = null
  }
}

function redraw() {
  if (!selLineId.value) return
  const lineId = selLineId.value
  unbind(lineId)
  activeLineId.value = lineId
  setTool('rect')
}

function deleteSelectedPlace() {
  const id = selPlaceId.value
  if (!id || !model.places[id]) return
  snapshot()
  delete model.places[id]
  selPlaceId.value = null
}

function rowAction(action) {
  const r = row.value
  if (!r) return
  if (action === 'dist') {
    snapshot()
    const result = distribute(model, r, lines.value, lineById.value, activeLineId.value)
    if (!result.bound) {
      undoStack.value.pop()
      say(r.cols.some((c) => !c) ? `Неразмеченных линий глубины ${r.depth} не осталось` : 'Свободных столбцов в ряду нет')
      return
    }
    if (activeLine.value && placedCount(model, activeLine.value) > 0) activeLineId.value = null
    say(`Разложено линий: ${result.bound}` + (result.emptyColumns ? ` (ещё ${result.emptyColumns} столбцов пусто — подходящие линии кончились)` : ''))
    return
  }
  if (action === 'dup') {
    snapshot()
    const copy = duplicateRow(model, r)
    selRowId.value = copy.id
    selLineId.value = null
    say('Копия ряда создана рядом')
    return
  }
  snapshot()
  const lookup = lineById.value
  if (action === 'k-') setK(model, r, r.k - 1, lookup)
  else if (action === 'k+') setK(model, r, r.k + 1, lookup)
  else if (action === 'kAuto') setK(model, r, suggestK(r, scale.value), lookup)
  else if (action === 'rot-90') r.angle = normalizeAngle(r.angle - 90)
  else if (action === 'rot+90') r.angle = normalizeAngle(r.angle + 90)
  else if (action === 'rot-1') r.angle = round1(normalizeAngle(r.angle - 1))
  else if (action === 'rot+1') r.angle = round1(normalizeAngle(r.angle + 1))
  else if (action === 'cut') {
    cutRow(r)
    say(`Нарезано ${r.k}×${r.depth}. «Раздать по порядку» или выберите линию слева и кликните столбец.`)
  } else if (action === 'reverse') r.cols.reverse()
  else if (action === 'unbindAll') r.cols.forEach((lineId) => lineId && unbindLine(model, lineId, lookup))
  else if (action === 'delete') {
    deleteRow(model, r, lookup)
    selRowId.value = null
    return
  }
  applyRow(model, r, lookup)
}

function chooseDepth(depth) {
  const r = row.value
  if (!r || r.depth === depth) return
  if (r.cut && r.cols.some(Boolean) && !window.confirm('При смене глубины привязанные линии этого ряда будут отвязаны. Продолжить?')) return
  snapshot()
  setDepth(model, r, depth, lineById.value)
  applyRow(model, r, lineById.value)
}

function chooseFront(front) {
  const r = row.value
  if (!r || r.front === front) return
  snapshot()
  r.front = front
  applyRow(model, r, lineById.value)
}

let inputSnapshotFor = null
function inputSnapshot(key) {
  if (inputSnapshotFor !== key) {
    snapshot()
    inputSnapshotFor = key
  }
}

function onKInput(value) {
  const r = row.value
  const k = parseInt(value, 10)
  if (!r || !Number.isFinite(k) || k === r.k) return
  inputSnapshot(`k${r.id}`)
  setK(model, r, k, lineById.value)
}

function onAngleInput(value) {
  const r = row.value
  const angle = parseFloat(String(value).replace(',', '.'))
  if (!r || !Number.isFinite(angle) || round1(normalizeAngle(angle)) === r.angle) return
  inputSnapshot(`a${r.id}`)
  r.angle = round1(normalizeAngle(angle))
  applyRow(model, r, lineById.value)
}

// ---------- pointer gestures ----------
const attr = (el, name) => (el && el.getAttribute ? el.getAttribute(name) : null)

function moveRowDrag(r, start, click) {
  const origin = { cx: r.cx, cy: r.cy }
  return {
    begin: snapshot,
    move(_event, point) {
      r.cx = round1(origin.cx + point[0] - start[0])
      r.cy = round1(origin.cy + point[1] - start[1])
      applyRow(model, r, lineById.value)
    },
    click
  }
}

function moveLineDrag(line, start, click) {
  const origin = {}
  for (const slot of line.slots) if (model.places[slot.placeId]) origin[slot.placeId] = model.places[slot.placeId].polygon
  return {
    begin: snapshot,
    move(_event, point) {
      for (const [id, polygon] of Object.entries(origin)) {
        model.places[id] = { polygon: translatePolygon(polygon, point[0] - start[0], point[1] - start[1]) }
      }
    },
    click
  }
}

function vertexDrag(placeId, index) {
  return {
    begin: snapshot,
    move(_event, point) {
      const polygon = model.places[placeId].polygon.slice()
      polygon[index] = point.map(round1)
      model.places[placeId] = { polygon }
    }
  }
}

function handleDrag(r, handle) {
  const original = { ...r }
  if (handle === 'rot') {
    let candidates = []
    return {
      begin() {
        snapshot()
        const own = new Set(r.cols.filter(Boolean).flatMap((lineId) => lineById.value[lineId]?.slots.map((s) => s.placeId) || []))
        candidates = angleCandidates({
          rows: model.rows,
          polygons: Object.entries(model.places).filter(([id]) => !own.has(id)).map(([, p]) => p.polygon),
          excludeRowId: r.id
        })
      },
      move(event, point) {
        const snapped = snapAngle(rotationAt(original, point), { candidates, shift: event.shiftKey, alt: event.altKey })
        r.angle = round1(normalizeAngle(snapped.angle))
        rotInfo.value = `${r.angle}°${snapped.reason ? ` · ${snapped.reason}` : ''}`
        applyRow(model, r, lineById.value)
      },
      end() {
        rotInfo.value = ''
      }
    }
  }
  return {
    begin: snapshot,
    move(_event, point) {
      Object.assign(r, resizeRow(original, handle, point))
      applyRow(model, r, lineById.value)
    }
  }
}

function drawDrag(start) {
  return {
    move(_event, point) {
      drawPreview.value = rectPolygon(start, point)
    },
    end() {
      const preview = drawPreview.value
      drawPreview.value = null
      if (!preview) return
      const w = preview[1][0] - preview[0][0]
      const h = preview[2][1] - preview[1][1]
      if (w < 10 * scale.value || h < 10 * scale.value) return
      if (tool.value === 'rect') {
        placePolygon(preview)
        return
      }
      snapshot()
      const created = addRow(
        model,
        rowFromCorners(preview[0], preview[2], { capacity: activeLine.value?.capacity || null, scale: scale.value })
      )
      selRowId.value = created.id
      selLineId.value = null
      selPlaceId.value = null
      say(`Ряд: предложено ${created.k}×${created.depth} — поправьте справа и нажмите «Нарезать»`)
    }
  }
}

function onPress(payload) {
  engaged = true
  const { target, point } = payload
  const handle = attr(target, 'data-h')
  const vertex = attr(target, 'data-vertex')
  const placeId = attr(target, 'data-pid')
  const rowId = attr(target, 'data-row')

  if (handle && row.value) {
    payload.drag = handleDrag(row.value, handle)
    return
  }
  if (vertex !== null && vertexPlace.value) {
    payload.drag = vertexDrag(vertexPlace.value.placeId, Number(vertex))
    return
  }
  if (tool.value === 'poly') {
    payload.click = (_event, at) => polyClick(at)
    return
  }
  if (tool.value === 'rect') {
    payload.drag = drawDrag(point)
    return
  }

  if (placeId && slotById.value.has(placeId)) {
    const { line } = slotById.value.get(placeId)
    const r = rowOfLine(model, line.lineId)
    const click = () => {
      if (activeLine.value && r && activeLineId.value !== line.lineId && activeLine.value.capacity === r.depth) {
        bindColumn(r, r.cols.indexOf(line.lineId))
        return
      }
      selLineId.value = line.lineId
      selPlaceId.value = r ? null : placeId
      selRowId.value = r ? r.id : null
    }
    payload.drag = r ? moveRowDrag(r, point, click) : moveLineDrag(line, point, click)
    return
  }

  if (placeId) {
    // A polygon for a place that is not on this floor's inventory (archived, or imported):
    // it can only be selected and deleted.
    payload.click = () => {
      clearSelection()
      selPlaceId.value = placeId
    }
    return
  }

  if (rowId) {
    const r = model.rows.find((candidate) => candidate.id === Number(rowId))
    const column = attr(target, 'data-col')
    if (r) {
      payload.drag = moveRowDrag(r, point, () => {
        if (activeLine.value && r.cut && column !== null && !r.cols[Number(column)]) {
          bindColumn(r, Number(column))
          return
        }
        selRowId.value = r.id
        selLineId.value = null
        selPlaceId.value = null
      })
      return
    }
  }

  if (tool.value === 'row') {
    payload.drag = drawDrag(point)
    return
  }

  payload.click = () => clearSelection()
}

function onPointerMove({ point }) {
  if (tool.value === 'poly' && polyPoints.value.length) mouse.value = point
}

function onDblClick() {
  if (tool.value === 'poly' && polyPoints.value.length >= 3) {
    const points = polyPoints.value
    const px = surface.value?.px || 1
    // The double click also landed its two clicks as vertices; drop the duplicate.
    if (points.length > 3 && distance(points[points.length - 1], points[points.length - 2]) < 6 * px) {
      polyPoints.value = points.slice(0, -1)
    }
    finishPoly()
  }
}

function onImageSize({ width, height }) {
  natural.width = width
  natural.height = height
}

// ---------- keyboard ----------
// Keys act only after the operator has pressed on this editor, so Backspace in some other
// card of the page never deletes a row here.
let engaged = false
let lastKeySnapshot = 0

function onDocumentPointerDown(event) {
  engaged = Boolean(root.value && root.value.contains(event.target))
}

const isTyping = (el) => /INPUT|TEXTAREA|SELECT/.test(el?.tagName || '') || el?.isContentEditable

function throttledSnapshot() {
  const time = Date.now()
  if (time - lastKeySnapshot > 800) snapshot()
  lastKeySnapshot = time
}

function onKeyDown(event) {
  if (!engaged || isTyping(event.target)) return
  const key = event.key.toLowerCase()
  const r = row.value

  if ((event.metaKey || event.ctrlKey) && key === 'z') {
    event.preventDefault()
    undo()
    return
  }
  if ((event.metaKey || event.ctrlKey) && key === 'd') {
    if (r) {
      event.preventDefault()
      rowAction('dup')
    }
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return

  if (event.key === 'Escape') {
    if (polyPoints.value.length) polyPoints.value = []
    else if (activeLineId.value) activeLineId.value = null
    else clearSelection()
    return
  }
  if (event.key === 'Enter' && tool.value === 'poly' && polyPoints.value.length) {
    finishPoly()
    return
  }
  if (event.key === '0') {
    surface.value?.fit()
    return
  }
  const shortcut = TOOLS.find((entry) => entry.key === key)
  if (shortcut && !event.shiftKey) {
    setTool(shortcut.value)
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    if (selLineId.value) {
      unbind(selLineId.value)
      say('Линия отвязана')
    } else if (selPlaceId.value) {
      deleteSelectedPlace()
      say('Место удалено')
    } else if (r) {
      rowAction('delete')
      say('Ряд удалён')
    }
    return
  }
  if (!r) return
  const step = event.shiftKey ? 10 : 1
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
  if (moves[event.key]) {
    event.preventDefault()
    throttledSnapshot()
    r.cx = round1(r.cx + moves[event.key][0])
    r.cy = round1(r.cy + moves[event.key][1])
    applyRow(model, r, lineById.value)
    return
  }
  if (['[', ']', '{', '}'].includes(event.key)) {
    throttledSnapshot()
    const delta = (event.shiftKey ? 15 : 1) * (event.key === '[' || event.key === '{' ? -1 : 1)
    r.angle = round1(normalizeAngle(r.angle + delta))
    applyRow(model, r, lineById.value)
    return
  }
  if (key === 'f') {
    const order = ['top', 'right', 'bottom', 'left']
    chooseFront(order[(order.indexOf(r.front) + 1) % 4])
  }
}

function onBeforeUnload(event) {
  if (dirty.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('beforeunload', onBeforeUnload)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('beforeunload', onBeforeUnload)
  clearTimeout(messageTimer)
  state.markupDirty = false
})

// ---------- save / discard ----------
function payload() {
  const places = {}
  for (const line of lines.value) {
    for (const slot of line.slots || []) {
      if (model.places[slot.placeId]) places[slot.placeId] = { polygon: model.places[slot.placeId].polygon }
    }
  }
  return {
    mapCode: state.floorCode,
    imageWidth: Math.round(imageWidth.value),
    imageHeight: Math.round(imageHeight.value),
    places,
    editor: editorBlob(model),
    revision: loaded.revision
  }
}

async function save() {
  if (!imageWidth.value || !imageHeight.value) {
    say('Размер изображения плана ещё неизвестен — дождитесь, пока план загрузится')
    return
  }
  busy.value = true
  try {
    const result = await saveMarkup(payload())
    if (result.ok) reset()
  } finally {
    busy.value = false
  }
}

async function discard() {
  if (dirty.value && !window.confirm('Отменить все несохранённые изменения разметки?')) return
  busy.value = true
  try {
    state.markupDirty = false
    await loadMarkup(state.floorCode)
    reset()
  } finally {
    busy.value = false
  }
}

const handleCursor = (r, key) => {
  const [sx, sy] = HANDLES[key]
  const angle = ((Math.atan2(sy, sx) * 180) / Math.PI + r.angle + 360) % 180
  return `${['ew', 'nwse', 'ns', 'nesw'][Math.round(angle / 45) % 4]}-resize`
}

function overlayFor(r, px) {
  const handles = Object.entries(HANDLES).map(([key, [sx, sy]]) => {
    const [x, y] = localToWorld(r, (sx * r.w) / 2, (sy * r.h) / 2)
    return { key, x, y, cursor: handleCursor(r, key) }
  })
  const top = localToWorld(r, 0, -r.h / 2)
  const rot = localToWorld(r, 0, -(r.h / 2 + 34 * px))
  const edge = frontEdge(r)
  const mid = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2]
  const out = [mid[0] - r.cx, mid[1] - r.cy]
  const length = Math.hypot(out[0], out[1]) || 1
  return {
    handles,
    top,
    rot,
    frontLabel: [mid[0] + (out[0] / length) * 24 * px, mid[1] + (out[1] / length) * 24 * px]
  }
}
</script>

<template>
  <div ref="root" class="plan-editor stack">
    <ViText v-if="!planSrc && !markup" tag="p" variant="body-M-wide" class="muted">
      Для этажа {{ currentFloor().title }} не загружена подложка — загрузите её ниже, в «Подложки
      этажей», и размечайте.
    </ViText>

    <template v-else>
      <ViAlert v-if="markup?.planChanged" type="warning" title="Подложка плана заменена">
        Изображение плана загрузили заново уже после разметки. Проверьте, что места совпадают с
        рисунком, и поправьте ряды.
      </ViAlert>
      <ViAlert v-if="state.markupError" type="warning" title="Разметку не удалось загрузить">
        {{ state.markupError }}
      </ViAlert>

      <div class="row plan-editor__actions">
        <ViText tag="span" variant="body-Mm-tight">
          Размечено {{ placedTotal }} из {{ totalSlots }}
        </ViText>
        <ViText v-if="placedTotal < totalSlots" tag="span" variant="body-XS-wide" class="muted">
          линий без разметки: {{ unplacedLines }}
        </ViText>
        <span class="plan-editor__spacer" />
        <ViButton color="primary" :loading="busy" :disabled="!dirty" @click="save">Сохранить</ViButton>
        <ViButton variant="outlined" color="secondary" :disabled="busy || !dirty" @click="discard">
          Отменить изменения
        </ViButton>
      </div>
      <ViText v-if="markup?.updatedAt" tag="p" variant="body-XS-wide" class="muted">
        Версия {{ markup.revision }} · {{ markup.updatedAt }}<template v-if="markup.updatedBy">
          · {{ markup.updatedBy.displayName || markup.updatedBy.login }}</template>
      </ViText>
      <ViText v-if="unknownPlaces.length" tag="p" variant="body-XS-wide" class="muted">
        Полигонов без места на этом этаже: {{ unknownPlaces.length }} — они не сохранятся. Выберите
        такой полигон на плане и нажмите Del.
      </ViText>

      <div class="plan-editor__grid">
        <!-- Left: the floor's lines. -->
        <aside class="plan-editor__list">
          <div class="filters">
            <ViChip interactive :selected="!listFilter.unplaced" @click="listFilter.unplaced = false">Все</ViChip>
            <ViChip interactive :selected="listFilter.unplaced" @click="listFilter.unplaced = true">
              Неразмеченные
            </ViChip>
          </div>
          <div class="filters">
            <ViChip
              v-for="depth in [1, 2, 3]"
              :key="depth"
              interactive
              :selected="listFilter.depth === depth"
              @click="listFilter.depth = listFilter.depth === depth ? 0 : depth"
            >
              ×{{ depth }}
            </ViChip>
          </div>

          <div class="plan-editor__active" :class="{ 'plan-editor__active--on': activeLine }">
            <ViText v-if="activeLine" tag="p" variant="body-XS-wide">
              Кладём <b>{{ lineLabel(activeLine) }}</b> (×{{ activeLine.capacity }}): кликните зелёный
              столбец ряда глубины {{ activeLine.capacity }} или нарисуйте «Место»/«Полигон».
            </ViText>
            <ViText v-else tag="p" variant="body-XS-wide" class="muted">
              Клик по неразмеченной линии — взять её в работу; по размеченной — показать на плане.
            </ViText>
          </div>

          <div class="plan-editor__lines">
            <button
              v-for="entry in listed"
              :key="entry.line.lineId"
              type="button"
              class="plan-editor__line"
              :class="[
                `plan-editor__line--${entry.state}`,
                {
                  'plan-editor__line--active': entry.line.lineId === activeLineId,
                  'plan-editor__line--selected': entry.line.lineId === selLineId
                }
              ]"
              :aria-pressed="entry.line.lineId === activeLineId"
              @click="onListClick(entry.line)"
            >
              <span class="slot-line">
                <ViText tag="span" variant="body-Sm-wide">{{ lineLabel(entry.line) }}</ViText>
                <ViText tag="span" variant="body-XS-wide" class="muted">
                  ×{{ entry.line.capacity }}<template v-if="entry.state === 'partial'"> · {{ entry.n }}/{{ entry.line.capacity }}</template><template v-if="entry.state === 'placed'"> · размечена</template>
                </ViText>
              </span>
              <ViText tag="span" variant="body-XS-wide" class="muted">{{ entry.line.name || entry.line.code }}</ViText>
            </button>
            <ViText v-if="!listed.length" tag="p" variant="body-XS-wide" class="muted">Линий нет.</ViText>
          </div>
        </aside>

        <!-- Centre: the plan. -->
        <div class="plan-editor__stage" :class="`plan-editor__stage--${tool}`">
          <PlanSurface
            ref="surface"
            :image-src="planSrc"
            :image-width="imageWidth"
            :image-height="imageHeight"
            height="70vh"
            label="Разметка плана этажа"
            @image-size="onImageSize"
            @press="onPress"
            @pointer-move="onPointerMove"
            @dblclick="onDblClick"
          >
            <template #default="{ px }">
              <g class="plan-editor__rows">
                <g
                  v-for="drawn in drawnRows"
                  :key="drawn.row.id"
                  class="plan-editor__row"
                  :class="{
                    'plan-editor__row--cut': drawn.row.cut,
                    'plan-editor__row--selected': drawn.row.id === selRowId
                  }"
                >
                  <polygon class="plan-editor__body" :data-row="drawn.row.id" :points="drawn.body" />
                  <polygon
                    v-for="cell in drawn.cells"
                    :key="`${cell.column}-${cell.depth}`"
                    class="plan-editor__cell"
                    :class="cell.cls"
                    :data-row="drawn.row.id"
                    :data-col="cell.column"
                    :points="cell.points"
                  />
                  <text
                    v-for="number in drawn.numbers"
                    :key="`n${number.column}`"
                    class="plan-editor__colnum"
                    :x="number.x"
                    :y="number.y"
                    :font-size="number.size"
                  >
                    {{ number.column + 1 }}
                  </text>
                  <line
                    class="plan-editor__front"
                    :x1="drawn.front[0][0]"
                    :y1="drawn.front[0][1]"
                    :x2="drawn.front[1][0]"
                    :y2="drawn.front[1][1]"
                  />
                </g>
              </g>

              <g class="plan-editor__places">
                <polygon
                  v-for="place in drawnPlaces"
                  :key="place.placeId"
                  class="plan-editor__place"
                  :class="{ 'plan-editor__place--unknown': !place.known, 'plan-editor__place--selected': place.selected }"
                  :data-pid="place.placeId"
                  :points="place.points"
                />
              </g>
              <g>
                <polygon v-for="outline in outlines" :key="outline.lineId" class="plan-editor__outline" :points="outline.points" />
              </g>
              <g>
                <text
                  v-for="place in drawnPlaces"
                  :key="place.placeId"
                  class="plan-editor__label"
                  :x="place.label.x"
                  :y="place.label.y"
                  :font-size="place.label.size"
                >
                  {{ place.code }}
                </text>
              </g>

              <!-- Overlay: handles of the selected row, vertex handles, drawing previews. -->
              <g v-if="row" class="plan-editor__overlay">
                <template v-for="o in [overlayFor(row, px)]" :key="row.id">
                  <line class="plan-editor__rotline" :x1="o.top[0]" :y1="o.top[1]" :x2="o.rot[0]" :y2="o.rot[1]" />
                  <rect
                    v-for="h in o.handles"
                    :key="h.key"
                    class="plan-editor__handle"
                    :data-h="h.key"
                    :x="h.x - 5.5 * px"
                    :y="h.y - 5.5 * px"
                    :width="11 * px"
                    :height="11 * px"
                    :transform="`rotate(${row.angle} ${h.x} ${h.y})`"
                    :style="{ cursor: h.cursor }"
                  />
                  <circle class="plan-editor__handle plan-editor__handle--rot" data-h="rot" :cx="o.rot[0]" :cy="o.rot[1]" :r="7 * px" />
                  <text class="plan-editor__fronttxt" :x="o.frontLabel[0]" :y="o.frontLabel[1]" :font-size="12 * px">перёд</text>
                  <text v-if="rotInfo" class="plan-editor__angtxt" :x="o.rot[0]" :y="o.rot[1] - 16 * px" :font-size="14 * px">
                    {{ rotInfo }}
                  </text>
                </template>
              </g>
              <g v-if="vertexPlace">
                <circle
                  v-for="(point, index) in vertexPlace.polygon"
                  :key="index"
                  class="plan-editor__vertex"
                  :data-vertex="index"
                  :cx="point[0]"
                  :cy="point[1]"
                  :r="5 * px"
                />
              </g>
              <polygon v-if="drawPreview" class="plan-editor__preview" :points="pointsAttr(drawPreview)" />
              <g v-if="tool === 'poly' && polyPoints.length">
                <polyline class="plan-editor__polyprev" :points="pointsAttr(mouse ? [...polyPoints, mouse] : polyPoints)" />
                <circle
                  v-for="(point, index) in polyPoints"
                  :key="index"
                  class="plan-editor__polypt"
                  :cx="point[0]"
                  :cy="point[1]"
                  :r="(index ? 3.5 : 6) * px"
                />
              </g>
            </template>

            <template #overlay>
              <div class="plan-editor__toolbar">
                <ViButton
                  v-for="entry in TOOLS"
                  :key="entry.value"
                  size="small"
                  :variant="tool === entry.value ? 'filled' : 'outlined'"
                  :color="tool === entry.value ? 'primary' : 'secondary'"
                  :aria-pressed="tool === entry.value"
                  :title="`${entry.title} (${entry.key.toUpperCase()})`"
                  @click="setTool(entry.value)"
                >
                  {{ entry.title }}
                </ViButton>
                <ViButton size="small" variant="outlined" color="secondary" :disabled="!undoStack.length" title="Ctrl/Cmd+Z" @click="undo">
                  ↶ Отменить
                </ViButton>
              </div>
              <div v-if="message" class="plan-editor__message" role="status">
                <ViText tag="span" variant="body-XS-wide">{{ message }}</ViText>
              </div>
            </template>
          </PlanSurface>
          <ViText tag="p" variant="body-XS-wide" class="muted plan-editor__hint">{{ hint }}</ViText>
        </div>

        <!-- Right: the selected row, the selected line, or how-to. -->
        <aside class="plan-editor__panel">
          <div v-if="row" class="stack">
            <ViText tag="h4" variant="title-h6">
              Ряд №{{ row.id }} · {{ row.cut ? 'нарезан' : 'черновик' }}
            </ViText>

            <ViInput
              :value="String(row.k)"
              label="Линий в ряду (K)"
              label-type="static"
              @update:value="onKInput"
            />
            <div class="row plan-editor__buttons">
              <ViButton size="small" variant="outlined" color="secondary" @click="rowAction('k-')">−</ViButton>
              <ViButton size="small" variant="outlined" color="secondary" @click="rowAction('k+')">+</ViButton>
              <ViButton size="small" variant="outlined" color="secondary" @click="rowAction('kAuto')">авто</ViButton>
            </div>

            <ViText tag="span" variant="body-XS-wide" class="muted">Глубина (машин в линии)</ViText>
            <div class="filters">
              <ViChip
                v-for="depth in [1, 2, 3]"
                :key="depth"
                interactive
                :selected="row.depth === depth"
                @click="chooseDepth(depth)"
              >
                {{ depth }}
              </ViChip>
            </div>

            <ViText tag="span" variant="body-XS-wide" class="muted">Перёд (выезд), до поворота</ViText>
            <div class="filters">
              <ViChip
                v-for="front in FRONTS"
                :key="front.value"
                interactive
                :selected="row.front === front.value"
                @click="chooseFront(front.value)"
              >
                {{ front.title }}
              </ViChip>
            </div>

            <ViInput
              :value="String(row.angle)"
              label="Поворот, °"
              label-type="static"
              @update:value="onAngleInput"
            />
            <div class="row plan-editor__buttons">
              <ViButton size="small" variant="outlined" color="secondary" @click="rowAction('rot-90')">⟲90</ViButton>
              <ViButton size="small" variant="outlined" color="secondary" @click="rowAction('rot+90')">⟳90</ViButton>
              <ViButton size="small" variant="outlined" color="secondary" @click="rowAction('rot-1')">−1</ViButton>
              <ViButton size="small" variant="outlined" color="secondary" @click="rowAction('rot+1')">+1</ViButton>
            </div>
            <ViText tag="p" variant="body-XS-wide" class="muted">
              Рамка {{ Math.round(row.w) }}×{{ Math.round(row.h) }} px
            </ViText>

            <ViButton v-if="!row.cut" color="primary" @click="rowAction('cut')">
              Нарезать {{ row.k }}×{{ row.depth }}
            </ViButton>

            <template v-else>
              <div class="row plan-editor__buttons">
                <ViButton size="small" color="primary" @click="rowAction('dist')">Раздать по порядку</ViButton>
                <ViButton size="small" variant="outlined" color="secondary" @click="rowAction('reverse')">
                  ⇄ Обратный порядок
                </ViButton>
                <ViButton
                  v-if="row.cols.some(Boolean)"
                  size="small"
                  variant="outlined"
                  color="secondary"
                  @click="rowAction('unbindAll')"
                >
                  Отвязать всё
                </ViButton>
              </div>
              <ViText tag="span" variant="body-XS-wide" class="muted">
                Столбцы {{ row.cols.filter(Boolean).length }}/{{ row.k }}
              </ViText>
              <ol class="plan-editor__cols">
                <li v-for="(lineId, column) in row.cols" :key="column" class="slot-line">
                  <template v-if="lineById[lineId]">
                    <ViText tag="span" variant="body-XS-wide">{{ lineLabel(lineById[lineId]) }}</ViText>
                    <ViButton size="small" variant="link" color="secondary" @click="unbind(lineId)">отвязать</ViButton>
                  </template>
                  <ViButton
                    v-else
                    size="small"
                    variant="link"
                    color="secondary"
                    class="plan-editor__bindcol"
                    @click="bindColumn(row, column)"
                  >
                    {{
                      activeLine
                        ? activeLine.capacity === row.depth
                          ? `→ положить ${lineLabel(activeLine)}`
                          : 'пусто (выбранная линия другой глубины)'
                        : 'пусто'
                    }}
                  </ViButton>
                </li>
              </ol>
            </template>

            <div class="row plan-editor__buttons">
              <ViButton size="small" variant="outlined" color="secondary" @click="rowAction('dup')">Дублировать</ViButton>
              <ViButton size="small" variant="outlined" color="error" @click="rowAction('delete')">Удалить ряд</ViButton>
            </div>
          </div>

          <div v-else-if="selLine" class="stack">
            <ViText tag="h4" variant="title-h6">Линия {{ lineLabel(selLine) }}</ViText>
            <ViText tag="p" variant="body-XS-wide" class="muted">
              {{ selLine.name || selLine.code }} · {{ CAPACITY_LABELS[selLine.capacity] || selLine.capacity }} ·
              размечено {{ placedCount(model, selLine) }} из {{ selLine.capacity }}
            </ViText>
            <ViText tag="p" variant="body-XS-wide" class="muted">
              Отдельные полигоны: тащите место — сдвинется вся линия; у выбранного места тащите вершины.
            </ViText>
            <div class="row plan-editor__buttons">
              <ViButton size="small" variant="outlined" color="secondary" @click="redraw">Нарисовать заново</ViButton>
              <ViButton size="small" variant="outlined" color="error" @click="unbind(selLine.lineId)">
                Отвязать
              </ViButton>
            </div>
          </div>

          <div v-else-if="selPlaceId" class="stack">
            <ViText tag="h4" variant="title-h6">Полигон без места</ViText>
            <ViText tag="p" variant="body-XS-wide" class="muted">
              Этого места нет в инвентаре этажа. Его можно только удалить.
            </ViText>
            <ViButton size="small" variant="outlined" color="error" @click="deleteSelectedPlace">Удалить полигон</ViButton>
          </div>

          <div v-else class="stack">
            <ViText tag="h4" variant="title-h6">Как размечать</ViText>
            <ol class="plan-editor__help">
              <li><b>Ряд</b> — протяните рамку поверх ряда мест.</li>
              <li>Справа задайте K, глубину 1–3 и сторону «перёд» (красная кромка).</li>
              <li>Подвиньте, потяните за углы, поверните за круглую ручку.</li>
              <li><b>Нарезать</b> → «Раздать по порядку» или выберите линию слева и кликните столбец.</li>
            </ol>
            <ViText tag="p" variant="body-XS-wide" class="muted">
              Для нестандартных мест — «Место» и «Полигон» (для выбранной слева линии).
              Клавиши: V R M P — инструменты, Ctrl/Cmd+Z — отмена, Del — удалить/отвязать, Esc —
              снять выбор, стрелки и [ ] — сдвиг и поворот ряда, F — сменить перёд, 0 — вписать.
            </ViText>
          </div>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.plan-editor__actions {
  align-items: center;
}

.plan-editor__spacer {
  flex: 1;
}

.plan-editor__grid {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) 250px;
  gap: 12px;
  align-items: start;
}

@media (max-width: 1100px) {
  .plan-editor__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.plan-editor__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 75vh;
}

.plan-editor__active {
  min-height: 48px;
  padding: 6px 8px;
  border: 1px solid var(--vi-color-gray-200);
  border-radius: var(--vi-radius-s);
  background: var(--vi-color-gray-50);
}

.plan-editor__active--on {
  border-color: var(--vi-color-green-500);
  background: var(--vi-color-green-50);
}

.plan-editor__lines {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: auto;
}

.plan-editor__line {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  border: 1px solid var(--vi-color-gray-200);
  border-left-width: 3px;
  border-radius: var(--vi-radius-s);
  background: var(--vi-color-white);
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.plan-editor__line--unplaced {
  border-left-color: var(--vi-color-orange-500);
}

.plan-editor__line--partial {
  border-left-color: var(--vi-color-yellow-500);
}

.plan-editor__line--placed {
  border-left-color: var(--vi-color-green-500);
}

.plan-editor__line--active {
  background: var(--vi-color-green-50);
  border-color: var(--vi-color-green-500);
}

.plan-editor__line--selected {
  background: var(--vi-color-red-50);
  border-color: var(--vi-color-red-500);
}

.plan-editor__stage {
  min-width: 0;
}

.plan-editor__stage--row :deep(svg),
.plan-editor__stage--rect :deep(svg),
.plan-editor__stage--poly :deep(svg) {
  cursor: crosshair;
}

.plan-editor__hint {
  margin-top: 6px;
}

.plan-editor__toolbar {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px;
  border-radius: var(--vi-radius-m);
  background: var(--vi-color-white);
  box-shadow: 0 1px 4px var(--vi-color-gray-300);
}

.plan-editor__message {
  display: table;
  margin-top: 6px;
  padding: 4px 10px;
  border-radius: var(--vi-radius-s);
  background: var(--vi-color-gray-900);
  color: var(--vi-color-white);
}

.plan-editor__buttons {
  gap: 4px;
  align-items: center;
}

.plan-editor__cols,
.plan-editor__help {
  margin: 0;
  padding-left: 20px;
}

/* SVG layers. Strokes keep their screen width at any zoom. */
.plan-editor polygon,
.plan-editor polyline,
.plan-editor line,
.plan-editor rect,
.plan-editor circle {
  vector-effect: non-scaling-stroke;
}

.plan-editor__body {
  fill: var(--vi-color-orange-500);
  fill-opacity: 0.08;
  stroke: var(--vi-color-orange-500);
  stroke-width: 1.5;
  stroke-dasharray: 7 4;
  cursor: move;
}

.plan-editor__row--cut .plan-editor__body {
  fill: none;
  stroke: var(--vi-color-purple-500);
  stroke-dasharray: none;
}

.plan-editor__row--selected .plan-editor__body {
  stroke-width: 3;
}

.plan-editor__cell {
  fill: none;
  stroke: var(--vi-color-orange-500);
  stroke-width: 1;
  stroke-dasharray: 4 3;
  pointer-events: none;
}

.plan-editor__row--cut .plan-editor__cell {
  fill: var(--vi-color-purple-500);
  fill-opacity: 0.07;
  stroke: var(--vi-color-purple-500);
  stroke-dasharray: none;
  pointer-events: all;
  cursor: pointer;
}

.plan-editor__row--cut .plan-editor__cell--ok {
  fill: var(--vi-color-green-500);
  fill-opacity: 0.3;
  stroke: var(--vi-color-green-500);
}

.plan-editor__row--cut .plan-editor__cell--no {
  fill: var(--vi-color-gray-500);
  fill-opacity: 0.12;
  cursor: not-allowed;
}

.plan-editor__front {
  stroke: var(--vi-color-red-500);
  stroke-width: 4;
  stroke-linecap: round;
  pointer-events: none;
}

.plan-editor__colnum {
  fill: var(--vi-color-purple-500);
  font-weight: 700;
  text-anchor: middle;
  dominant-baseline: central;
  pointer-events: none;
}

.plan-editor__place {
  fill: var(--vi-color-blue-500);
  fill-opacity: 0.38;
  stroke: var(--vi-color-blue-800);
  stroke-width: 1.2;
  cursor: pointer;
}

.plan-editor__place--unknown {
  fill: var(--vi-color-gray-500);
  fill-opacity: 0.45;
  stroke: var(--vi-color-gray-800);
}

.plan-editor__place--selected {
  fill: var(--vi-color-red-500);
  fill-opacity: 0.32;
  stroke: var(--vi-color-red-500);
  stroke-width: 3;
}

.plan-editor__outline {
  fill: none;
  stroke: var(--vi-color-gray-1000);
  stroke-width: 1.6;
  pointer-events: none;
}

.plan-editor__label {
  font-family: var(--vi-font-family);
  font-weight: 700;
  fill: var(--vi-color-gray-1000);
  paint-order: stroke;
  stroke: var(--vi-color-white);
  stroke-width: 3px;
  stroke-linejoin: round;
  text-anchor: middle;
  dominant-baseline: central;
  pointer-events: none;
}

.plan-editor__handle {
  fill: var(--vi-color-white);
  stroke: var(--vi-color-purple-500);
  stroke-width: 2;
}

.plan-editor__handle--rot {
  fill: var(--vi-color-purple-500);
  stroke: var(--vi-color-white);
  cursor: grab;
}

.plan-editor__rotline {
  stroke: var(--vi-color-purple-500);
  stroke-width: 1.5;
  pointer-events: none;
}

.plan-editor__fronttxt {
  fill: var(--vi-color-red-500);
  font-weight: 700;
  text-anchor: middle;
  dominant-baseline: central;
  pointer-events: none;
}

.plan-editor__angtxt {
  fill: var(--vi-color-white);
  font-weight: 700;
  paint-order: stroke;
  stroke: var(--vi-color-purple-500);
  stroke-width: 4px;
  stroke-linejoin: round;
  text-anchor: middle;
  pointer-events: none;
}

.plan-editor__vertex {
  fill: var(--vi-color-white);
  stroke: var(--vi-color-red-500);
  stroke-width: 2;
  cursor: move;
}

.plan-editor__preview {
  fill: var(--vi-color-purple-500);
  fill-opacity: 0.12;
  stroke: var(--vi-color-purple-500);
  stroke-width: 1.5;
  stroke-dasharray: 6 4;
  pointer-events: none;
}

.plan-editor__polyprev {
  fill: var(--vi-color-green-500);
  fill-opacity: 0.15;
  stroke: var(--vi-color-green-500);
  stroke-width: 2;
  pointer-events: none;
}

.plan-editor__polypt {
  fill: var(--vi-color-green-500);
  pointer-events: none;
}
</style>
