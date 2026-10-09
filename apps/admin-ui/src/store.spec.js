import { afterEach, describe, expect, it, vi } from 'vitest'

import { boot, firstPopulatedFloor, loadDay, state, submit } from './store'

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
    '/admin/dashboard': DASHBOARD,
    '/admin/places': { places: [{ id: 'p1', code: '118' }] },
    '/admin/place-lines': LINES,
    '/admin/employees': { employees: [{ id: 'u1', displayName: 'Иванов' }] },
    '/admin/line-occupancy': { occupancy: [] },
    '/admin/employee-parking-requests': { requests: [{ id: 'r1' }, { id: 'r2' }] },
    '/admin/guest-parking-requests': { requests: [{ id: 'g1' }] },
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

function resetState() {
  Object.assign(state, {
    ready: false,
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
    guestRequests: []
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
