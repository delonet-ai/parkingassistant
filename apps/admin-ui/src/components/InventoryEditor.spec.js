import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import InventoryEditor from './InventoryEditor.vue'
import { state } from '../store'

const LINES = [
  {
    lineId: 'l1',
    code: 'line-4-101',
    name: 'Линия G4 / 101',
    capacity: 2,
    floorLabel: '4',
    slots: [
      { placeId: 'p101', code: '101', position: 1, status: 'free', placeRole: 'regular' },
      { placeId: 'p102', code: '102', position: 2, status: 'occupied', placeRole: 'rotatable' }
    ]
  },
  { lineId: 'l2', code: 'line-5-501', capacity: 1, floorLabel: '5', slots: [] }
]

function setState(overrides = {}) {
  Object.assign(state, {
    date: '2026-10-09',
    floorCode: 'g4',
    lines: LINES,
    places: [{ id: 'p101', code: '101' }, { id: 'p102', code: '102' }],
    notice: null,
    ...overrides
  })
}

function stub(answer = { status: 'ok' }, status = 200) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } })
  )
  vi.stubGlobal('fetch', fetchMock)

  return fetchMock
}

const buttonBy = (wrapper, text) =>
  wrapper.findAll('button').find((button) => button.text().includes(text))

// ViModal teleports its content to document.body, so the wrapper never contains it. Asserting
// on the document is the only way to see what the operator sees.
async function settle(wrapper) {
  await flushPromises()
  await wrapper.vm.$nextTick()
}

const overlayText = () => document.body.textContent || ''

const overlayButton = (text) =>
  [...document.body.querySelectorAll('button')].find((button) => (button.textContent || '').includes(text))

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('InventoryEditor', () => {
  it('shows only the chosen floor', () => {
    setState()

    expect(mount(InventoryEditor).text()).toContain('101')
    expect(mount(InventoryEditor).text()).not.toContain('line-5-501')
  })

  it('asks before adding, and suggests free codes', async () => {
    setState()
    const wrapper = mount(InventoryEditor)

    // Nothing is created by pressing the toolbar button alone.
    expect(wrapper.findComponent({ name: 'ViModal' }).props('isOpened')).toBe(false)

    await buttonBy(wrapper, '+ Тройное').trigger('click')
    await settle(wrapper)

    expect(overlayText()).toContain('Новый элемент на 3 мест')
    // Highest existing numeric code is 102, so the suggestion starts at 103.
    expect(document.body.querySelector('input').value).toBe('103')
  })

  it('creates the element with one slot per place', async () => {
    setState()
    const fetchMock = stub()
    const wrapper = mount(InventoryEditor)

    await buttonBy(wrapper, '+ Двойное').trigger('click')
    await settle(wrapper)
    overlayButton('Создать').click()
    await settle(wrapper)

    const [url, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body)

    expect(url).toBe('/api/admin/place-lines')
    expect(body.capacity).toBe(2)
    expect(body.floorLabel).toBe('4')
    expect(body.slots).toEqual([
      { code: '103', placeRole: 'regular', guestPriorityRank: null },
      { code: '104', placeRole: 'regular', guestPriorityRank: null }
    ])
  })

  it('names the places before archiving changes the count', async () => {
    setState()
    const wrapper = mount(InventoryEditor)

    await buttonBy(wrapper, 'Удалить').trigger('click')
    await settle(wrapper)

    expect(overlayText()).toContain('Это изменит состав парковки')
    expect(overlayText()).toContain('101, 102')
  })

  it('repeats the blockers the API names when archiving is refused', async () => {
    setState()
    stub(
      {
        status: 'error',
        error: 'Place still has active reservations',
        blockers: [{ placeCode: '101', type: 'reservation', detail: 'назначено на 2026-10-09' }]
      },
      409
    )
    const wrapper = mount(InventoryEditor)

    await buttonBy(wrapper, 'Удалить').trigger('click')
    await settle(wrapper)
    overlayButton('Удалить').click()
    await settle(wrapper)

    expect(state.notice.type).toBe('error')
    expect(state.notice.text).toContain('101 — назначено на 2026-10-09')
  })

  it('changes a slot role without touching anything else about the place', async () => {
    setState()
    const fetchMock = stub()
    const wrapper = mount(InventoryEditor)

    wrapper.findAllComponents({ name: 'ViSelect' })[0].vm.$emit('update:value', 'blocked')
    await flushPromises()

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      placeId: 'p101',
      placeRole: 'blocked'
    })
  })
})
