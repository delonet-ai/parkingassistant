import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import LineOccupancy from './LineOccupancy.vue'
import { state } from '../store'

const LINE_GROUPS = [
  {
    id: 'double',
    code: 'line-4-101',
    name: 'Линия G4 / 101',
    capacity: 2,
    places: [
      { id: 'p101', code: '101', positionHint: 1 },
      { id: 'p102', code: '102', positionHint: 2 }
    ]
  },
  {
    id: 'triple',
    code: 'line-4-110',
    name: 'Линия G4 / 110',
    capacity: 3,
    places: [
      { id: 'p110', code: '110', positionHint: 1 },
      { id: 'p111', code: '111', positionHint: 2 },
      { id: 'p112', code: '112', positionHint: 3 }
    ]
  }
]

const OCCUPANCY = [
  {
    id: 'o1',
    position: 1,
    subjectType: 'employee',
    lineGroup: { code: 'line-4-101', name: 'Линия G4 / 101' },
    parkingPlace: { code: '101' },
    user: { displayName: 'Иванов И. И.', phone: '+7 900 000-00-01', email: 'ivanov@demo.invalid' },
    reservation: { source: 'permanent' }
  },
  {
    id: 'o2',
    position: 2,
    subjectType: 'guest',
    lineGroup: { code: 'line-4-101', name: 'Линия G4 / 101' },
    parkingPlace: { code: '102' },
    guestParkingRequest: { guestName: 'Тихонова Елена', hostDisplayName: 'Морозов Е. Н.' },
    reservation: { source: 'guest' }
  }
]

function setState(overrides = {}) {
  Object.assign(state, {
    date: '2026-10-09',
    lineGroups: LINE_GROUPS,
    occupancy: OCCUPANCY,
    employees: [{ id: 'u1', displayName: 'Петров П. П.', department: 'ИТ' }],
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

const selects = (wrapper) => wrapper.findAllComponents({ name: 'ViSelect' })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LineOccupancy', () => {
  it('builds the position list from the chosen line, not from a fixed 1/2/3', async () => {
    setState()
    const wrapper = mount(LineOccupancy)

    // Nothing chosen yet: there is no line to take a capacity from.
    expect(selects(wrapper)[1].props('options')).toEqual([])

    selects(wrapper)[0].vm.$emit('update:value', 'double')
    await flushPromises()
    expect(selects(wrapper)[1].props('options').map((option) => option.value)).toEqual([1, 2])

    selects(wrapper)[0].vm.$emit('update:value', 'triple')
    await flushPromises()
    expect(selects(wrapper)[1].props('options').map((option) => option.value)).toEqual([1, 2, 3])
  })

  it('offers only the places that belong to the chosen line', async () => {
    setState()
    const wrapper = mount(LineOccupancy)

    selects(wrapper)[0].vm.$emit('update:value', 'double')
    await flushPromises()

    expect(selects(wrapper)[2].props('options').map((option) => option.text)).toEqual(['101', '102'])
  })

  it('clears position and place when the line changes, so a stale pair cannot be posted', async () => {
    setState()
    const wrapper = mount(LineOccupancy)

    selects(wrapper)[0].vm.$emit('update:value', 'triple')
    await flushPromises()
    selects(wrapper)[1].vm.$emit('update:value', 3)
    selects(wrapper)[2].vm.$emit('update:value', 'p112')
    await flushPromises()

    // Position 3 does not exist on a double line.
    selects(wrapper)[0].vm.$emit('update:value', 'double')
    await flushPromises()

    expect(selects(wrapper)[1].props('value')).toBe(null)
    expect(selects(wrapper)[2].props('value')).toBe(null)
  })

  it('routes to the inviting employee when a guest stands in front, instead of a phone', () => {
    setState()
    const text = mount(LineOccupancy).text()

    expect(text).toContain('+7 900 000-00-01')
    expect(text).toContain('Через приглашающего: Морозов Е. Н.')
    expect(text).toContain('Гость: Тихонова Елена')
  })

  it('posts the fixed position with the fields the API expects', async () => {
    setState()
    const fetchMock = stub()
    const wrapper = mount(LineOccupancy)

    selects(wrapper)[0].vm.$emit('update:value', 'double')
    await flushPromises()
    selects(wrapper)[1].vm.$emit('update:value', 2)
    selects(wrapper)[2].vm.$emit('update:value', 'p102')
    selects(wrapper)[3].vm.$emit('update:value', 'u1')
    await flushPromises()

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Зафиксировать')
      .trigger('click')
    await flushPromises()

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      occupancyDate: '2026-10-09',
      lineGroupId: 'double',
      parkingPlaceId: 'p102',
      position: 2,
      subjectType: 'employee',
      userId: 'u1'
    })
  })

  it('says the day is empty rather than rendering a headerless table', () => {
    setState({ occupancy: [] })

    expect(mount(LineOccupancy).text()).toContain('позиции в линиях ещё не зафиксированы')
  })
})
