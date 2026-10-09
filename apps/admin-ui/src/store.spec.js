import { afterEach, describe, expect, it, vi } from 'vitest'

import { boot, buildUrl, endSession, firstPopulatedFloor, loadDay, readUrl, signIn, signOut, state, submit } from './store'

const ME = {
  status: 'ok',
  user: { id: 'au1', login: 'sysadmin', displayName: 'Системный администратор', authStatus: 'active', roles: ['system_admin'] }
}

const DASHBOARD = {
  status: 'ok',
  date: '2026-10-09',
  releasedPlaces: [{ parkingPlace: { id: 'p1', code: '118' }, owner: { displayName: 'Иванов' }, isReserved: false }],
  reservations: [],
  guestReserve: { minimum: 5, availablePlaces: 7, status: 'ok' },
  guestRequests: []
}

const LINES = {
  lines: [
    {
      lineId: 'l1',
      capacity: 1,
      floorLabel: '4',
      slots: [{ placeId: 'p1', code: '118', position: 1, status: 'released' }]
    }
  ]
}

/** One canned answer per path, so a test exercises the real request/parse/assign path. */
function stubApi(overrides = {}) {
  const answers = {
    '/auth/me': ME,
    '/admin/dashboard': DASHBOARD,
    '/admin/places': { places: [{ id: 'p1', code: '118' }] },
    '/admin/place-lines': LINES,
    '/admin/employees': { employees: [{ id: 'u1', displayName: 'Иванов' }] },
    '/admin/line-occupancy': { occupancy: [] },
    '/admin/employee-parking-requests': { requests: [{ id: 'r1' }, { id: 'r2' }] },
    '/admin/guest-parking-requests': { requests: [{ id: 'g1' }] },
    '/admin/line-groups': { lineGroups: [{ id: 'l1', code: 'line-4-118', capacity: 3 }] },
    '/admin/departure-plans': { departurePlans: [] },
    '/admin/conflicts': { conflicts: [] },
    '/admin/contact-access-logs': { contactAccessLogs: [] },
    '/admin/permanent-assignments': { permanentAssignments: [] },
    '/admin/audit-logs': { auditLogs: [] },
    '/admin/jobs/runs': { runs: [], latestSuccessfulRuns: [] },
    '/admin/map-diagnostics': { maps: [], diagnostics: {} },
    ...overrides
  }

  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const path = new URL(url, 'http://local').pathname.replace(/^\/api/, '')
    const answer = answers[path]

    if (answer === undefined) {
      return new Response(JSON.stringify({ status: 'error', error: `no stub for ${path}` }), { status: 500 })
    }
    if (answer instanceof Response) {
      return answer
    }

    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }))
}

/** A response with a status, which the stub passes through as-is. */
function refused(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function resetState() {
  Object.assign(state, {
    ready: false,
    authStage: 'loading',
    authUser: null,
    authRoles: [],
    bootstrapLogin: null,
    authError: null,
    authBusy: false,
    bootError: null,
    today: null,
    date: null,
    floorCode: null,
    selectedPlaceId: null,
    notice: null,
    dashboard: null,
    lines: [],
    places: [],
    employees: [],
    occupancy: [],
    employeeRequests: [],
    guestRequests: [],
    lineGroups: [],
    departurePlans: [],
    conflicts: [],
    contactAccessLogs: [],
    permanentAssignments: [],
    assignmentStatusFilter: 'all',
    history: null,
    auditLogs: [],
    auditFilters: { entityType: '', action: '' },
    jobRuns: { runs: [], latestSuccessfulRuns: [] },
    maps: [],
    mapDiagnostics: { placeWithoutLine: [], lineCapacityMismatch: [] }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetState()
})

describe('firstPopulatedFloor', () => {
  it('skips a configured floor the catalog has nothing on', () => {
    // The imported catalog has no G3, and opening on an empty floor reads to the operator
    // as "there are no places at all".
    expect(firstPopulatedFloor([{ floorLabel: '4' }, { floorLabel: '5' }])).toBe('g4')
    expect(firstPopulatedFloor([{ floorLabel: '3' }])).toBe('g3')
    expect(firstPopulatedFloor([])).toBe('g3')
  })
})

describe('loadDay', () => {
  it('fills the day from the API and takes «today» from it, not from the browser clock', async () => {
    stubApi()

    const result = await loadDay()

    expect(result.ok).toBe(true)
    expect(state.today).toBe('2026-10-09')
    expect(state.date).toBe('2026-10-09')
    expect(state.lines).toHaveLength(1)
    expect(state.employeeRequests).toHaveLength(2)
    expect(state.guestRequests).toHaveLength(1)
    expect(state.floorCode).toBe('g4')
  })

  it('reports the API error instead of rendering a half-loaded day', async () => {
    stubApi({
      '/admin/place-lines': new Response(
        JSON.stringify({ status: 'error', error: 'Internal server error' }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      )
    })

    const result = await loadDay()

    expect(result).toEqual({ ok: false, error: 'Internal server error' })
    expect(state.lines).toEqual([])
  })

  it('boot surfaces the failure rather than leaving the shell on «Загрузка…»', async () => {
    stubApi({ '/admin/dashboard': undefined })

    await boot()

    expect(state.ready).toBe(false)
    expect(state.bootError).toContain('no stub')
    // The session resolved; only the data did not. The operator stays inside the app.
    expect(state.authStage).toBe('ready')
  })
})

describe('session', () => {
  const REFUSAL = { status: 'error', error: 'Authentication required' }

  it('renders the app only when /auth/me names someone', async () => {
    stubApi()

    await boot()

    expect(state.authStage).toBe('ready')
    expect(state.ready).toBe(true)
    expect(state.authUser.login).toBe('sysadmin')
    expect(state.authRoles).toEqual(['system_admin'])
  })

  it('asks for a sign-in when nobody is signed in, and fetches no parking data', async () => {
    stubApi({
      '/auth/me': refused(401, REFUSAL),
      '/auth/bootstrap-status': { status: 'ok', bootstrapUser: { login: 'sysadmin', authStatus: 'active' } }
    })

    await boot()

    expect(state.authStage).toBe('login')
    expect(state.ready).toBe(false)
    expect(state.dashboard).toBeNull()
  })

  it('asks for a first password while the bootstrap operator is still invited', async () => {
    stubApi({
      '/auth/me': refused(401, REFUSAL),
      '/auth/bootstrap-status': { status: 'ok', bootstrapUser: { login: 'sysadmin', authStatus: 'invited' } }
    })

    await boot()

    expect(state.authStage).toBe('activate')
    expect(state.bootstrapLogin).toBe('sysadmin')
  })

  it('shows the real reason when /auth/me fails for something other than a refusal', async () => {
    stubApi({ '/auth/me': refused(500, { status: 'error', error: 'db unreachable' }) })

    await boot()

    // A password cannot fix this, so the screen says what actually happened.
    expect(state.authStage).toBe('login')
    expect(state.authError).toBe('db unreachable')
  })

  it('keeps the API message and no session after a refused sign-in', async () => {
    stubApi({ '/auth/login': refused(401, { status: 'error', error: 'Invalid login or password' }) })

    const result = await signIn({ login: 'sysadmin', password: 'wrong' })

    expect(result.ok).toBe(false)
    expect(state.authError).toBe('Invalid login or password')
    expect(state.authUser).toBeNull()
    expect(state.ready).toBe(false)
  })

  it('loads the day as soon as a sign-in succeeds', async () => {
    stubApi({ '/auth/login': ME })

    await signIn({ login: 'sysadmin', password: 'a-real-password' })

    expect(state.authStage).toBe('ready')
    expect(state.ready).toBe(true)
    expect(state.lines).toHaveLength(1)
  })

  it('ends the session on a 401 from any other call, without an error toast', async () => {
    stubApi()
    await boot()

    stubApi({ '/admin/audit-logs': refused(401, REFUSAL) })
    const result = await loadDay()

    expect(result.ok).toBe(false)
    expect(state.authStage).toBe('login')
    expect(state.ready).toBe(false)
    expect(state.notice).toBeNull()
    expect(state.authError).toBe('Сессия завершена. Войдите снова.')
  })

  it('logs out through the API and drops the screen without a message', async () => {
    stubApi({ '/auth/logout': { status: 'ok', revoked: true } })
    await boot()

    await signOut()

    expect(window.fetch.mock.calls.map((call) => String(call[0]))).toContain('/api/auth/logout')
    expect(state.authStage).toBe('login')
    expect(state.authUser).toBeNull()
    // The operator asked for this, so there is nothing to explain.
    expect(state.authError).toBeNull()
  })

  it('endSession clears what belonged to the session it ended', async () => {
    stubApi()
    await boot()
    state.history = { kind: 'place', id: 'p1', data: null, error: null }
    state.notice = { type: 'success', text: 'Назначено.' }

    endSession('Сессия завершена. Войдите снова.')

    expect(state.history).toBeNull()
    expect(state.notice).toBeNull()
    expect(state.ready).toBe(false)
  })
})

describe('submit', () => {
  it('shows the API message on a refused write and does not claim success', async () => {
    stubApi({
      '/admin/reservations/manual': new Response(
        JSON.stringify({ status: 'error', error: 'Place already has an active reservation' }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      )
    })

    const result = await submit('/admin/reservations/manual', {}, 'Назначено.')

    expect(result.ok).toBe(false)
    expect(state.notice).toEqual({
      type: 'error',
      text: 'Place already has an active reservation'
    })
  })

  it('renders API warning objects, which is how a guest in front of an early departure arrives', async () => {
    stubApi({
      '/admin/reservations/manual': {
        status: 'ok',
        warnings: [{ type: 'guest_blocks_early_departure', message: 'Гость перекрывает выезд в 16:30' }]
      }
    })

    await submit('/admin/reservations/manual', {}, 'Место назначено.')

    expect(state.notice.type).toBe('success')
    expect(state.notice.text).toBe('Место назначено. Предупреждение: Гость перекрывает выезд в 16:30')
  })

  it('reloads the day after a successful write so the screen cannot drift from the backend', async () => {
    stubApi({ '/admin/reservations/cancel': { status: 'ok' } })

    await submit('/admin/reservations/cancel', { reservationId: 'r1' }, 'Отменено.')

    expect(state.dashboard).not.toBeNull()
    expect(state.lines).toHaveLength(1)
  })
})

describe('URL state', () => {
  it('reads the four keys the SSR admin used, rejecting anything malformed', () => {
    expect(readUrl('?view=lines&date=2026-10-09&mapCode=g5&placeId=abc')).toEqual({
      view: 'lines',
      date: '2026-10-09',
      floorCode: 'g5',
      selectedPlaceId: 'abc'
    })

    // An unknown tab, a non-ISO date and a floor that is not configured fall back rather
    // than being handed to the API.
    expect(readUrl('?view=hack&date=09.10.2026&mapCode=g9')).toEqual({
      view: 'day',
      date: null,
      floorCode: null,
      selectedPlaceId: null
    })
  })

  it('writes back only what is set, so a bare day keeps a clean address', () => {
    Object.assign(state, { view: 'day', date: '2026-10-09', floorCode: 'g4', selectedPlaceId: null })
    expect(buildUrl()).toBe('?view=day&date=2026-10-09&mapCode=g4')

    state.selectedPlaceId = 'p1'
    expect(buildUrl()).toBe('?view=day&date=2026-10-09&mapCode=g4&placeId=p1')
  })

  it('boot honours a deep link to a place on a floor', async () => {
    stubApi()

    await boot('?mapCode=g5&placeId=p1&date=2026-10-08')

    expect(state.floorCode).toBe('g5')
    expect(state.selectedPlaceId).toBe('p1')
    expect(state.date).toBe('2026-10-08')
  })
})
