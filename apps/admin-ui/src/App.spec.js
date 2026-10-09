import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App.vue'
import { reloadAudit, state } from './store'

// The component specs mount pieces. This one mounts the whole app the way the browser does,
// because a runtime error in the shell — a bad `component :is`, a provider a component needs,
// a boot path that throws — produces a blank page while every other check stays green.

const OPERATOR = {
  id: 'au1',
  login: 'sysadmin',
  displayName: 'Системный администратор',
  authStatus: 'active',
  roles: ['system_admin']
}

const ANSWERS = {
  '/auth/me': { status: 'ok', user: OPERATOR },
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

/** A stubbed answer is a payload, or `refused(status, payload)` when the status matters. */
function refused(status, payload) {
  return { __status: status, payload }
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

    if (answer && answer.__status) {
      return new Response(JSON.stringify(answer.payload), {
        status: answer.__status,
        headers: { 'content-type': 'application/json' }
      })
    }

    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }))
}

async function boot(answers, search = '/') {
  stubApi(answers)
  // The app writes its screen into the URL, so a previous test's address would otherwise
  // decide which tab this one lands on.
  window.history.replaceState(null, '', search)
  Object.assign(state, {
    view: 'day',
    ready: false,
    bootError: null,
    today: null,
    date: null,
    floorCode: null,
    selectedPlaceId: null,
    notice: null,
    authStage: 'loading',
    authUser: null,
    authRoles: [],
    bootstrapLogin: null,
    authError: null,
    authBusy: false
  })

  const wrapper = mount(App)
  await flushPromises()
  await flushPromises()
  await flushPromises()

  return wrapper
}

/**
 * The tab strip's own titles. `wrapper.text()` is not specific enough for this one: the day
 * screen says «Доступно к назначению», which contains the word «Доступ» and would make a
 * hidden tab look present.
 */
function tabTitles(wrapper) {
  return wrapper.findAll('[class*="tab-name"]').map((node) => node.text())
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

  it('says why it is empty when the day cannot be loaded, with the session intact', async () => {
    // Signed in, and nothing else answers: the failure is about data, so the operator stays
    // inside the app with the API's message rather than being sent back to a login form.
    const wrapper = await boot({ '/auth/me': ANSWERS['/auth/me'] })

    expect(wrapper.text()).toContain('Не удалось загрузить данные')
    expect(wrapper.text()).not.toContain('Загрузка…')
    expect(wrapper.text()).toContain('Выйти')
  })

  it('names the signed-in operator and offers a way out', async () => {
    const wrapper = await boot()

    expect(wrapper.text()).toContain('Системный администратор')
    expect(wrapper.text()).toContain('system_admin')
    expect(wrapper.findAll('button').some((button) => button.text() === 'Выйти')).toBe(true)
  })

  it('shows the login screen and no tab strip when nobody is signed in', async () => {
    const wrapper = await boot({
      '/auth/me': refused(401, { status: 'error', error: 'Authentication required' }),
      '/auth/bootstrap-status': { status: 'ok', bootstrapUser: { login: 'sysadmin', authStatus: 'active' } }
    })
    const text = wrapper.text()

    expect(text).toContain('Вход для администратора парковки')
    // Not one tab, not one KPI, not one request to the parking endpoints.
    for (const tab of ['День', 'Заявки', 'Линии', 'Справочники', 'Журнал', 'Места']) {
      expect(text).not.toContain(tab)
    }
    expect(text).not.toContain('Первый вход')
    expect(window.fetch.mock.calls.map((call) => String(call[0]))).toEqual([
      '/api/auth/me',
      '/api/auth/bootstrap-status'
    ])
  })

  it('offers the first-run form only while the bootstrap operator is still invited', async () => {
    const wrapper = await boot({
      '/auth/me': refused(401, { status: 'error', error: 'Authentication required' }),
      '/auth/bootstrap-status': { status: 'ok', bootstrapUser: { login: 'sysadmin', authStatus: 'invited' } }
    })

    expect(wrapper.text()).toContain('Первый вход')
    expect(state.bootstrapLogin).toBe('sysadmin')
  })

  it('signs in from the login screen and renders the day', async () => {
    const wrapper = await boot({
      ...ANSWERS,
      '/auth/me': refused(401, { status: 'error', error: 'Authentication required' }),
      '/auth/bootstrap-status': { status: 'ok', bootstrapUser: { login: 'sysadmin', authStatus: 'active' } },
      '/auth/login': { status: 'ok', user: OPERATOR }
    })
    const inputs = wrapper.findAll('input')

    await inputs[0].setValue('sysadmin')
    await inputs[1].setValue('a-real-password')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    await flushPromises()

    const text = wrapper.text()

    expect(text).not.toContain('Вход для администратора парковки')
    expect(text).toContain('Отдано мест')
    expect(text).toContain('Таблицы дня')
    expect(state.authUser.login).toBe('sysadmin')
  })

  // The Доступ tab is the one screen a role decides. The API refuses `/admin/users` for a
  // `parking_admin`, so offering them the tab would be offering them a 403.
  it('offers the Доступ tab to a system_admin and renders the account list on it', async () => {
    const wrapper = await boot({
      ...ANSWERS,
      '/admin/users': {
        status: 'ok',
        users: [
          {
            id: 'au1',
            login: 'sysadmin',
            displayName: 'Системный администратор',
            authStatus: 'active',
            lastLoginAt: null,
            roles: [{ code: 'system_admin', name: 'Системный администратор' }]
          }
        ]
      }
    })

    expect(tabTitles(wrapper)).toContain('Доступ')

    state.view = 'access'
    await flushPromises()
    await flushPromises()

    const text = wrapper.text()

    expect(text).toContain('Новая учётная запись')
    expect(text).toContain('Учётные записи · 1')
    expect(text).toContain('sysadmin')
  })

  it('hides the Доступ tab from a parking_admin, and never asks for the account list', async () => {
    const wrapper = await boot({
      ...ANSWERS,
      '/auth/me': { status: 'ok', user: { ...OPERATOR, login: 'operator', roles: ['parking_admin'] } }
    })
    const text = wrapper.text()

    // The day is theirs; the account list is not.
    expect(text).toContain('Таблицы дня')
    expect(tabTitles(wrapper)).toEqual(['День', 'Заявки', 'Линии', 'Справочники', 'Журнал', 'Места'])
    expect(window.fetch.mock.calls.map((call) => String(call[0]))).not.toContain('/api/admin/users')
  })

  it('drops a pasted ?view=access back to the day for an operator whose role cannot open it', async () => {
    const wrapper = await boot(
      {
        ...ANSWERS,
        '/auth/me': { status: 'ok', user: { ...OPERATOR, login: 'operator', roles: ['parking_admin'] } }
      },
      '/?view=access'
    )

    expect(state.view).toBe('day')
    expect(wrapper.text()).toContain('Таблицы дня')
    expect(wrapper.text()).not.toContain('Новая учётная запись')
  })

  it('returns to the login screen when the session ends mid-session', async () => {
    const wrapper = await boot()

    expect(wrapper.text()).toContain('Таблицы дня')

    // The session expires under the operator: the next read is refused.
    stubApi({ '/admin/audit-logs': refused(401, { status: 'error', error: 'Authentication required' }) })
    await reloadAudit({ action: 'queue_processed' })
    await flushPromises()

    const text = wrapper.text()

    expect(text).toContain('Сессия завершена. Войдите снова.')
    expect(text).toContain('Вход для администратора парковки')
    expect(text).not.toContain('Таблицы дня')
    expect(state.ready).toBe(false)
  })
})
