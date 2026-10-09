import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import PlaceDrawer from './PlaceDrawer.vue'
import { state } from '../store'

const PLACE = {
  id: 'p1',
  code: '118',
  title: '118',
  floorLabel: '4',
  placeType: 'triple',
  lineGroup: { code: 'line-4-118' },
  permanentOwner: { displayName: 'Иванов Иван Иванович' }
}

const LINES = [
  { lineId: 'l1', capacity: 3, floorLabel: '4', slots: [{ placeId: 'p1', code: '118', position: 1, status: 'released' }] }
]

function setDay(overrides = {}) {
  Object.assign(state, {
    date: '2026-10-09',
    selectedPlaceId: 'p1',
    places: [PLACE],
    lines: LINES,
    employees: [{ id: 'u1', displayName: 'Петров П. П.', department: 'СТМ' }],
    occupancy: [],
    notice: null,
    dashboard: { releasedPlaces: [], reservations: [], guestRequests: [] },
    ...overrides
  })
}

function stubPost(answer = { status: 'ok' }) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  )
  vi.stubGlobal('fetch', fetchMock)

  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PlaceDrawer', () => {
  it('says nothing is selected rather than rendering an empty card', () => {
    setDay({ selectedPlaceId: null })

    expect(mount(PlaceDrawer).text()).toContain('Место не выбрано')
  })

  it('shows the status the slot shows, taken from the API and not re-derived', () => {
    setDay()

    // The drawer used to derive status itself and could disagree with the slot next to it.
    expect(mount(PlaceDrawer).text()).toContain('отдано')
  })

  it('refuses the release action when the place has no permanent owner', () => {
    setDay({ places: [{ ...PLACE, permanentOwner: null }] })

    expect(mount(PlaceDrawer).text()).toContain('У места нет постоянного владельца')
  })

  it('offers manual assignment only for a released place with no reservation', () => {
    setDay({
      dashboard: {
        releasedPlaces: [{ parkingPlace: { id: 'p1' }, owner: { displayName: 'Иванов' }, releaseId: 'rel1' }],
        reservations: [],
        guestRequests: []
      }
    })

    expect(mount(PlaceDrawer).text()).toContain('Назначить сотрудника')
  })

  it('withholds manual assignment while the place is already reserved', () => {
    setDay({
      dashboard: {
        releasedPlaces: [{ parkingPlace: { id: 'p1' }, owner: { displayName: 'Иванов' }, releaseId: 'rel1' }],
        reservations: [{ id: 'res1', parkingPlace: { id: 'p1' }, source: 'manual', user: { displayName: 'Петров' } }],
        guestRequests: []
      }
    })

    const text = mount(PlaceDrawer).text()

    expect(text).toContain('Ручное назначение доступно только')
    expect(text).toContain('Отменить назначение')
  })

  it('explains why returning a place to its owner is blocked instead of just disabling it', () => {
    setDay({
      dashboard: {
        releasedPlaces: [{ parkingPlace: { id: 'p1' }, owner: { displayName: 'Иванов' }, releaseId: 'rel1' }],
        reservations: [{ id: 'res1', parkingPlace: { id: 'p1' }, source: 'manual', user: { displayName: 'Петров' } }],
        guestRequests: []
      }
    })

    expect(mount(PlaceDrawer).text()).toContain('Сначала отмените назначение')
  })

  it('carries what was typed into the comment through to the request body', async () => {
    // Vision UI inputs expose `value` and are bound with v-model:value. A plain v-model
    // binds modelValue instead, renders fine, and silently posts nothing — so this asserts
    // the binding rather than the markup.
    setDay()
    const fetchMock = stubPost()
    const wrapper = mount(PlaceDrawer)

    await wrapper.find('input').setValue('уезжаю в отпуск')
    await wrapper.findAll('button').find((button) => button.text().includes('Отдать на')).trigger('click')
    await Promise.resolve()

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).notes).toBe('уезжаю в отпуск')
  })

  it('posts the release for the selected day with the field names the API expects', async () => {
    setDay()
    const fetchMock = stubPost()
    const wrapper = mount(PlaceDrawer)

    await wrapper.findAll('button').find((button) => button.text().includes('Отдать на')).trigger('click')
    await Promise.resolve()

    const [url, init] = fetchMock.mock.calls[0]

    expect(url).toBe('/api/admin/place-releases')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      parkingPlaceId: 'p1',
      dateFrom: '2026-10-09',
      dateTo: '2026-10-09',
      notes: null
    })
  })
})
