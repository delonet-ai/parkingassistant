import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import GuestRequests from './GuestRequests.vue'
import { state } from '../store'

const REQUESTS = [
  {
    id: 'g1',
    status: 'active',
    guestName: 'Тихонова Елена',
    guestPhone: '+7 900 100-00-02',
    vehiclePlateNumber: 'У777УУ199',
    host: { displayName: 'Морозов Е. Н.' }
  },
  {
    id: 'g2',
    status: 'assigned',
    guestName: 'Николаев Сергей',
    assignedReservation: { parkingPlace: { code: '110' } }
  }
]

function setState(overrides = {}) {
  Object.assign(state, {
    date: '2026-10-09',
    guestRequests: REQUESTS,
    employees: [{ id: 'u1', displayName: 'Петров П. П.' }],
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GuestRequests', () => {
  it('shows the guest, the host and the place that was given', () => {
    setState()
    const text = mount(GuestRequests).text()

    expect(text).toContain('Тихонова Елена')
    expect(text).toContain('Морозов Е. Н.')
    expect(text).toContain('110')
    expect(text).toContain('подана')
    expect(text).toContain('выдано')
  })

  it('offers «назначить» to a waiting guest and «отменить» to a placed one', () => {
    setState()
    const labels = mount(GuestRequests)
      .findAll('button')
      .map((button) => button.text())

    expect(labels).toContain('Назначить место')
    expect(labels).toContain('Отменить')
  })

  it('assigns through the API, which picks the place by its own rule', async () => {
    setState()
    const fetchMock = stub()
    const wrapper = mount(GuestRequests)

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Назначить место')
      .trigger('click')
    await flushPromises()

    const [url, init] = fetchMock.mock.calls[0]

    expect(url).toBe('/api/admin/guest-parking-requests/assign')
    expect(JSON.parse(init.body)).toEqual({ requestId: 'g1' })
  })

  it('surfaces the warning when a guest is placed in front of an early departure', async () => {
    setState()
    stub({
      status: 'ok',
      warnings: [{ type: 'guest_blocks_early_departure', message: 'Гость перекрывает выезд в 16:30' }]
    })
    const wrapper = mount(GuestRequests)

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Назначить место')
      .trigger('click')
    await flushPromises()

    expect(state.notice.type).toBe('success')
    expect(state.notice.text).toContain('Гость перекрывает выезд в 16:30')
  })

  it('says the day is empty instead of rendering a headerless table', () => {
    setState({ guestRequests: [] })

    expect(mount(GuestRequests).text()).toContain('На эту дату гостевых заявок нет.')
  })
})
