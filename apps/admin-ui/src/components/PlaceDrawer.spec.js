import { flushPromises, mount } from '@vue/test-utils'
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

function stubPost(answer = { status: 'ok' }, httpStatus = 200) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(answer), { status: httpStatus, headers: { 'content-type': 'application/json' } })
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

    // The place is taken, so the drawer offers cancel and move, not another assignment — and
    // it does not explain the free-place rule to an operator looking at a taken place.
    expect(text).not.toContain('Назначить сотрудника')
    expect(text).not.toContain('Ручное назначение доступно только')
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

  describe('moving a reservation to another place', () => {
    // p1 is held for the day; p2 is released and open, p3 is released but already taken,
    // p4 has no permanent owner, p5 is with its owner, p6 is blocked.
    const RESERVED_DAY_LINES = [
      {
        lineId: 'l1',
        capacity: 3,
        floorLabel: '4',
        slots: [
          { placeId: 'p1', code: '118', position: 1, status: 'occupied' },
          { placeId: 'p2', code: '120', position: 2, status: 'released' },
          { placeId: 'p3', code: '121', position: 3, status: 'occupied' }
        ]
      },
      {
        lineId: 'l2',
        capacity: 3,
        floorLabel: '4',
        slots: [
          { placeId: 'p4', code: '130', position: 1, status: 'free' },
          { placeId: 'p5', code: '131', position: 2, status: 'owner' },
          { placeId: 'p6', code: '132', position: 3, status: 'blocked' }
        ]
      }
    ]

    function setReservedDay() {
      setDay({
        lines: RESERVED_DAY_LINES,
        dashboard: {
          releasedPlaces: [
            { parkingPlace: { id: 'p1', code: '118' }, owner: { displayName: 'Иванов' }, releaseId: 'rel1', isReserved: true },
            { parkingPlace: { id: 'p2', code: '120', placeType: 'double' }, owner: { displayName: 'Сидоров' }, releaseId: 'rel2', isReserved: false },
            { parkingPlace: { id: 'p3', code: '121', placeType: 'single' }, owner: { displayName: 'Орлов' }, releaseId: 'rel3', isReserved: true }
          ],
          reservations: [{ id: 'res1', parkingPlace: { id: 'p1' }, source: 'manual', user: { displayName: 'Петров' } }],
          guestRequests: []
        }
      })
    }

    const moveSelect = (wrapper) =>
      wrapper.findAllComponents({ name: 'ViSelect' }).find((select) => select.props('label') === 'Новое место')

    it('offers only the open places other than this one: released or without an owner', () => {
      setReservedDay()
      const wrapper = mount(PlaceDrawer)

      expect(wrapper.text()).toContain('Перевести на другое место')
      expect(moveSelect(wrapper).props('options').map((option) => option.value)).toEqual(['p2', 'p4'])
    })

    it('is not offered for a place nobody holds', () => {
      setDay()

      expect(mount(PlaceDrawer).text()).not.toContain('Перевести на другое место')
    })

    it('posts the reservation, the picked place and the reason the API expects', async () => {
      setReservedDay()
      const fetchMock = stubPost()
      const wrapper = mount(PlaceDrawer)

      moveSelect(wrapper).vm.$emit('update:value', 'p2')
      await wrapper.vm.$nextTick()
      const reasonInput = wrapper
        .findAllComponents({ name: 'ViInput' })
        .find((input) => input.props('label') === 'Причина перевода')
      await reasonInput.find('input').setValue('владелец вернулся')
      await wrapper.findAll('button').find((button) => button.text() === 'Перевести').trigger('click')
      await Promise.resolve()

      const [url, init] = fetchMock.mock.calls[0]

      expect(url).toBe('/api/admin/reservations/move')
      expect(JSON.parse(init.body)).toEqual({
        reservationId: 'res1',
        toParkingPlaceId: 'p2',
        reason: 'владелец вернулся'
      })
    })

    it('keeps the move button disabled until a place is picked', () => {
      setReservedDay()
      const button = mount(PlaceDrawer).findAll('button').find((item) => item.text() === 'Перевести')

      expect(button.attributes('disabled')).toBeDefined()
    })

    // The endpoint refuses by design — taken, blocked, not released — so a refusal is the
    // common case, and wiping the operator's choice on it would make them re-pick the place
    // and retype the reason before they could read why.
    it('keeps the picked place and the reason when the API refuses the move', async () => {
      setReservedDay()
      stubPost({ status: 'error', error: 'Place 120 is already taken on 2026-10-09 by Орлов' }, 409)
      const wrapper = mount(PlaceDrawer)

      moveSelect(wrapper).vm.$emit('update:value', 'p2')
      await wrapper.vm.$nextTick()
      const reasonInput = wrapper
        .findAllComponents({ name: 'ViInput' })
        .find((input) => input.props('label') === 'Причина перевода')
      await reasonInput.find('input').setValue('владелец вернулся')
      await wrapper.findAll('button').find((button) => button.text() === 'Перевести').trigger('click')
      await flushPromises()

      expect(state.notice.type).toBe('error')
      expect(state.notice.text).toContain('already taken')
      expect(moveSelect(wrapper).props('value')).toBe('p2')
      expect(reasonInput.find('input').element.value).toBe('владелец вернулся')
    })

    it('says there is nowhere to move to rather than offering an empty picker', () => {
      setDay({
        lines: [{ lineId: 'l1', capacity: 1, floorLabel: '4', slots: [{ placeId: 'p1', code: '118', position: 1, status: 'occupied' }] }],
        dashboard: {
          releasedPlaces: [
            { parkingPlace: { id: 'p1', code: '118' }, owner: { displayName: 'Иванов' }, releaseId: 'rel1', isReserved: true }
          ],
          reservations: [{ id: 'res1', parkingPlace: { id: 'p1' }, source: 'manual', user: { displayName: 'Петров' } }],
          guestRequests: []
        }
      })

      expect(mount(PlaceDrawer).text()).toContain('нет свободных мест')
    })
  })

  describe('manual assignment', () => {
    const slotOf = (status) => [
      { lineId: 'l1', capacity: 1, floorLabel: '4', slots: [{ placeId: 'p1', code: '118', position: 1, status }] }
    ]

    it('is offered for a place without a permanent owner, not only for a released one', () => {
      setDay({ lines: slotOf('free'), places: [{ ...PLACE, permanentOwner: null }] })

      expect(mount(PlaceDrawer).text()).toContain('Назначить сотрудника')
    })

    it('is not offered while the owner holds the place', () => {
      setDay({ lines: slotOf('owner') })

      expect(mount(PlaceDrawer).text()).not.toContain('Назначить сотрудника')
    })
  })
})
