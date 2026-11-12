import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import PlanEditor from './PlanEditor.vue'
import { centroid } from '../plan/geometry'
import { state } from '../store'

const LINES = [
  {
    lineId: 'l1',
    code: 'line-4-101',
    name: 'Линия G4 / 101',
    capacity: 2,
    floorLabel: '4',
    slots: [
      { placeId: 'p101', code: '101', position: 1, status: 'free' },
      { placeId: 'p102', code: '102', position: 2, status: 'owner' }
    ]
  },
  {
    lineId: 'l3',
    code: 'line-4-103',
    name: 'Линия G4 / 103',
    capacity: 2,
    floorLabel: '4',
    slots: [
      { placeId: 'p104', code: '104', position: 2, status: 'free' },
      { placeId: 'p103', code: '103', position: 1, status: 'free' }
    ]
  },
  { lineId: 'l2', code: 'line-4-110', capacity: 1, floorLabel: '4', slots: [{ placeId: 'p110', code: '110', position: 1, status: 'free' }] },
  { lineId: 'l5', code: 'line-5-501', capacity: 2, floorLabel: '5', slots: [] }
]

// A drawn but not yet cut row: 2 lines × 2 cars, front at the bottom.
const DRAFT_ROW = { id: 1, cx: 500, cy: 300, w: 200, h: 240, angle: 0, k: 2, depth: 2, front: 'bottom', cut: false, cols: [] }

const MARKUP = {
  mapCode: 'g4',
  imageWidth: 1000,
  imageHeight: 600,
  places: {},
  editor: { version: 1, rowSeq: 2, rows: [DRAFT_ROW] },
  revision: 3,
  planChanged: false,
  updatedAt: '2026-11-12T10:00:00Z',
  updatedBy: null
}

let wrapper = null

function setState(overrides = {}) {
  Object.assign(state, {
    floorCode: 'g4',
    lines: LINES,
    maps: [{ code: 'g4', title: 'G4', floorLabel: '4', metadata: { filePath: 'plan-g4.png' } }],
    markup: structuredClone(MARKUP),
    markupError: null,
    markupDirty: false,
    notice: null,
    ...overrides
  })
}

function stub(answer, status = 200) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } })
  )
  vi.stubGlobal('fetch', fetchMock)

  return fetchMock
}

const buttonBy = (text) => wrapper.findAll('button').find((button) => button.text().includes(text))

/** Press and release on an SVG element without moving: the surface reads it as a click. */
async function tap(element) {
  element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }))
  window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }))
  await flushPromises()
}

async function cutDraftRow() {
  await tap(wrapper.find('polygon.plan-editor__body').element)
  await buttonBy('Нарезать 2×2').trigger('click')
  await flushPromises()
}

const polygonOf = (body, placeId) => body.places[placeId].polygon

async function saveBody(fetchMock) {
  await buttonBy('Сохранить').trigger('click')
  await flushPromises()

  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('/api/admin/map-markup')
  expect(init.method).toBe('POST')

  return JSON.parse(init.body)
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
})

describe('PlanEditor', () => {
  it('lists the lines of the current floor only and counts what is marked', () => {
    setState()
    wrapper = mount(PlanEditor)

    const text = wrapper.text()
    expect(text).toContain('101·102')
    expect(text).toContain('103·104')
    expect(text).not.toContain('501')
    expect(text).toContain('Размечено 0 из 5')
  })

  it('keeps «Сохранить» disabled until something changes', async () => {
    setState()
    wrapper = mount(PlanEditor)

    expect(buttonBy('Сохранить').attributes('disabled')).toBeDefined()

    await cutDraftRow()

    expect(buttonBy('Сохранить').attributes('disabled')).toBeUndefined()
    expect(state.markupDirty).toBe(true)
  })

  it('cuts a row into K × depth cells', async () => {
    setState()
    wrapper = mount(PlanEditor)

    // A draft shows its grid too, but the cells only become targets once cut.
    await cutDraftRow()

    const cells = wrapper.findAll('polygon.plan-editor__cell')
    expect(cells).toHaveLength(4)
    expect(new Set(cells.map((cell) => cell.attributes('data-col')))).toEqual(new Set(['0', '1']))
    expect(wrapper.text()).toContain('Столбцы 0/2')
  })

  it('binds a chosen line into a column, slots front → back', async () => {
    setState()
    const fetchMock = stub({ status: 'ok', markup: { ...MARKUP, revision: 4 } })
    wrapper = mount(PlanEditor)

    await cutDraftRow()
    await buttonBy('103·104').trigger('click')
    await buttonBy('→ положить 103·104').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Размечено 2 из 5')

    const body = await saveBody(fetchMock)
    // Front is the bottom edge: position 1 (103) is the lower cell, position 2 (104) behind it.
    expect(centroid(polygonOf(body, 'p103'))[1]).toBeGreaterThan(centroid(polygonOf(body, 'p104'))[1])
    expect(Math.max(...polygonOf(body, 'p103').map((point) => point[1]))).toBe(420)
    // First column: the left half of the row.
    expect(centroid(polygonOf(body, 'p103'))[0]).toBeLessThan(500)
  })

  it('posts the markup with the revision it loaded and the rows in `editor`', async () => {
    setState()
    const fetchMock = stub({ status: 'ok', markup: { ...MARKUP, revision: 4 } })
    wrapper = mount(PlanEditor)

    await cutDraftRow()
    await buttonBy('Раздать по порядку').trigger('click')
    await flushPromises()

    const body = await saveBody(fetchMock)

    expect(body).toMatchObject({ mapCode: 'g4', imageWidth: 1000, imageHeight: 600, revision: 3 })
    expect(Object.keys(body.places).sort()).toEqual(['p101', 'p102', 'p103', 'p104'])
    expect(body.places.p101.polygon).toHaveLength(4)
    expect(body.editor.rows).toHaveLength(1)
    expect(body.editor.rows[0]).toMatchObject({ id: 1, cut: true, cols: ['l1', 'l3'] })
    expect(state.notice).toEqual({ type: 'success', text: 'Разметка плана сохранена.' })
    expect(state.markup.revision).toBe(4)
  })

  it('sends revision null for a floor that had no markup', async () => {
    setState({ markup: null })
    const fetchMock = stub({ status: 'ok', markup: { ...MARKUP, revision: 1 } })
    wrapper = mount(PlanEditor)

    // No markup means no image size from the API: the surface reads the image's own.
    wrapper.findComponent({ name: 'PlanSurface' }).vm.$emit('image-size', { width: 800, height: 500 })
    await flushPromises()
    await buttonBy('103·104').trigger('click')
    // Draw a rectangle place for the active line through the surface's press contract.
    await wrapper.findAll('button').find((button) => button.text() === 'Место').trigger('click')
    const press = { event: {}, point: [10, 10], target: wrapper.find('svg').element, drag: null, click: null }
    wrapper.findComponent({ name: 'PlanSurface' }).vm.$emit('press', press)
    press.drag.move({}, [70, 130])
    press.drag.end()
    await flushPromises()

    const body = await saveBody(fetchMock)
    expect(body.revision).toBeNull()
    expect(body.imageWidth).toBe(800)
    expect(body.places.p103.polygon).toEqual([[10, 10], [70, 10], [70, 130], [10, 130]])
  })

  it('reports a 409 and keeps the edits', async () => {
    setState()
    stub({ status: 'error', code: 'conflict', error: 'Разметку уже изменили.' }, 409)
    wrapper = mount(PlanEditor)

    await cutDraftRow()
    await buttonBy('Раздать по порядку').trigger('click')
    await buttonBy('Сохранить').trigger('click')
    await flushPromises()

    expect(state.notice.type).toBe('error')
    expect(state.notice.text).toContain('Разметку уже изменили.')
    expect(state.notice.text).toContain('Отменить изменения')
    expect(wrapper.text()).toContain('Размечено 4 из 5')
    expect(buttonBy('Сохранить').attributes('disabled')).toBeUndefined()
    expect(state.markup.revision).toBe(3)
  })

  it('drags a vertex of a free-standing place', async () => {
    setState({
      markup: {
        ...structuredClone(MARKUP),
        editor: {},
        places: { p110: { polygon: [[10, 10], [60, 10], [60, 120], [10, 120]] } }
      }
    })
    stub({ status: 'ok', markup: MARKUP })
    wrapper = mount(PlanEditor)

    await tap(wrapper.find('polygon[data-pid="p110"]').element)
    const vertices = wrapper.findAll('circle.plan-editor__vertex')
    expect(vertices).toHaveLength(4)

    const press = { event: {}, point: [60, 10], target: vertices[1].element, drag: null, click: null }
    wrapper.findComponent({ name: 'PlanSurface' }).vm.$emit('press', press)
    press.drag.begin()
    press.drag.move({}, [75.04, 4])
    await flushPromises()

    expect(wrapper.find('polygon[data-pid="p110"]').attributes('points')).toBe('10,10 75,4 60,120 10,120')
  })
})
