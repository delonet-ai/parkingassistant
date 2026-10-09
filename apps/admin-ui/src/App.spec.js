import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App.vue'
import { state } from './store'

// The component specs mount pieces. This one mounts the whole app the way the browser does,
// because a runtime error in the shell — a bad `component :is`, a provider a component needs,
// a boot path that throws — produces a blank page while every other check stays green.

const ANSWERS = {
  '/admin/dashboard': {
    status: 'ok',
    date: '2026-10-09',
    releasedPlaces: [
      { parkingPlace: { id: 'p2', code: '110' }, owner: { displayName: 'Николаев Сергей' }, isReserved: false, releaseId: 'rel1' }
    ],
    reservations: [
      {
        id: 'res1',
        parkingPlace: { id: 'p3', code: '120' },
        user: { displayName: 'Петров П. П.', department: 'СТМ' },
        source: 'manual',
        reason: null,
        reservationDate: '2026-10-09'
      }
    ],
    guestRequests: [],
    guestReserve: { minimum: 5, availablePlaces: 5, status: 'ok' }
  },
  '/admin/places': {
    places: [
      { id: 'p1', code: '118', title: '118', floorLabel: '4', placeType: 'triple', lineGroup: { code: 'line-4-118' }, permanentOwner: { displayName: 'Иванов И. И.' } }
    ]
  },
  '/admin/place-lines': {
    lines: [
      {
        lineId: 'l1',
        code: 'line-4-118',
        name: 'Линия 4 / 118',
        capacity: 3,
        floorLabel: '4',
        slots: [
          { placeId: 'p1', code: '118', placeType: 'triple', position: 1, status: 'free' },
          { placeId: 'p2', code: '119', placeType: 'triple', position: 2, status: 'released' },
          { placeId: 'p3', code: '120', placeType: 'triple', position: 3, status: 'occupied', userDisplayName: 'Петров П. П.' }
        ]
      }
    ]
  },
  '/admin/employees': { employees: [{ id: 'u1', displayName: 'Петров П. П.', department: 'СТМ' }] },
  '/admin/line-occupancy': { occupancy: [] },
  '/admin/employee-parking-requests': { requests: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] },
  '/admin/guest-parking-requests': { requests: [{ id: 'g1' }, { id: 'g2' }] },
  '/admin/line-groups': { lineGroups: [] },
  '/admin/departure-plans': { departurePlans: [] },
  '/admin/conflicts': { conflicts: [] },
  '/admin/contact-access-logs': { contactAccessLogs: [] },
  '/admin/permanent-assignments': { permanentAssignments: [] },
  '/admin/audit-logs': { auditLogs: [] },
  '/admin/jobs/runs': { runs: [], latestSuccessfulRuns: [] },
  '/admin/map-diagnostics': { maps: [], diagnostics: { placeWithoutLine: [], lineCapacityMismatch: [] } }
}

function stubApi(answers = ANSWERS) {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = new URL(url, 'http://local').pathname.replace(/^\/api/, '')
    const answer = answers[path]

    if (answer === undefined) {
      return new Response(JSON.stringify({ status: 'error', error: `no stub for ${path}` }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      })
    }

    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }))
}

async function boot(answers) {
  stubApi(answers)
  Object.assign(state, { ready: false, bootError: null, today: null, date: null, floorCode: null, selectedPlaceId: null, notice: null })

  const wrapper = mount(App)
  await flushPromises()
  await flushPromises()

  return wrapper
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('renders the tab strip and the День screen after boot, not a blank page', async () => {
    const wrapper = await boot()
    const text = wrapper.text()

    expect(text).toContain('Parking Assistant')
    for (const tab of ['День', 'Заявки', 'Линии', 'Справочники', 'Журнал', 'Места']) {
      expect(text).toContain(tab)
    }

    // The Day screen itself, not just the shell around it.
    expect(text).toContain('Отдано мест')
    expect(text).toContain('Гостевой резерв')
    expect(wrapper.findAll('button.slot-button')).toHaveLength(3)
    expect(text).toContain('Таблицы дня')
  })

  it('lands on the floor that has inventory and renders its slots', async () => {
    const wrapper = await boot()

    expect(state.floorCode).toBe('g4')
    expect(wrapper.text()).toContain('118')
    expect(wrapper.text()).toContain('свободно')
    expect(wrapper.text()).toContain('занято')
  })

  it('opens the place drawer when a slot is clicked', async () => {
    const wrapper = await boot()

    expect(wrapper.text()).toContain('Место не выбрано')

    await wrapper.findAll('button.slot-button')[0].trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('Место не выбрано')
    expect(wrapper.text()).toContain('Операции по месту')
    expect(wrapper.text()).toContain('Иванов И. И.')
  })

  it('renders the day tables with the reservation and its cancel control', async () => {
    const wrapper = await boot()
    const text = wrapper.text()

    expect(text).toContain('Активные назначения')
    expect(text).toContain('Петров П. П.')
    expect(wrapper.findAll('button').some((button) => button.text() === 'Отменить')).toBe(true)
  })

  it('renders the Заявки screen, not the placeholder', async () => {
    const wrapper = await boot()

    state.view = 'requests'
    await flushPromises()

    const text = wrapper.text()

    expect(text).not.toContain('ещё не перенесена')
    expect(text).toContain('Заявки и очередь')
    expect(text).toContain('Заявки сотрудников')
    expect(text).toContain('Очередь')
    expect(text).toContain('Гостевые заявки')
  })

  it('renders the Линии screen with occupancy, departures and the contact log', async () => {
    const wrapper = await boot()

    state.view = 'lines'
    await flushPromises()

    const text = wrapper.text()

    expect(text).not.toContain('ещё не перенесена')
    expect(text).toContain('Фактические позиции')
    expect(text).toContain('Время выезда и конфликты')
    expect(text).toContain('Запросы контактов')
  })

  it('renders the Справочники screen with all three catalogs', async () => {
    const wrapper = await boot()

    state.view = 'catalog'
    await flushPromises()

    const text = wrapper.text()

    expect(text).not.toContain('ещё не перенесена')
    expect(text).toContain('Сотрудники')
    expect(text).toContain('Места')
    expect(text).toContain('Постоянные закрепления')
  })

  it('renders the Журнал screen with actions, contacts and jobs', async () => {
    const wrapper = await boot()

    state.view = 'audit'
    await flushPromises()

    const text = wrapper.text()

    expect(text).not.toContain('ещё не перенесена')
    expect(text).toContain('Действия')
    expect(text).toContain('Регламентные задачи')
    expect(text).toContain('Обработка очереди')
  })

  it('renders the Места screen — every tab is migrated, no placeholder is left', async () => {
    const wrapper = await boot()

    state.view = 'places'
    await flushPromises()

    const text = wrapper.text()

    expect(text).not.toContain('ещё не перенесена')
    expect(text).toContain('Инвентарь')
    expect(text).toContain('Подложки этажей')
    expect(text).toContain('+ Тройное')
  })

  it('says why it is empty when the API cannot be reached', async () => {
    const wrapper = await boot({})

    expect(wrapper.text()).toContain('Не удалось загрузить данные')
    expect(wrapper.text()).not.toContain('Загрузка…')
  })
})
