import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import QueuePanel from './QueuePanel.vue'
import { state } from '../store'

const REQUESTS = [
  {
    id: 'r2',
    status: 'queued',
    user: { displayName: 'Волков А. В.' },
    queueEntry: { position: 2, status: 'waiting' }
  },
  {
    id: 'r1',
    status: 'assigned',
    user: { displayName: 'Смирнова О. А.' },
    queueEntry: { position: 1, status: 'assigned' },
    assignedReservation: { id: 'res1', parkingPlaceCode: '120' }
  },
  // No queue entry: an own-request employee never joined the queue, and must not appear here.
  { id: 'r3', status: 'active', user: { displayName: 'Морозов Е. Н.' }, queueEntry: null }
]

function setState(overrides = {}) {
  Object.assign(state, {
    date: '2026-10-09',
    employeeRequests: REQUESTS,
    notice: null,
    dashboard: null,
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('QueuePanel', () => {
  it('lists only queued requests, in position order', () => {
    setState()
    const text = mount(QueuePanel).text()

    expect(text).toContain('№1')
    expect(text).toContain('№2')
    expect(text).not.toContain('Морозов Е. Н.')
    expect(text.indexOf('Смирнова О. А.')).toBeLessThan(text.indexOf('Волков А. В.'))
  })

  it('shows the place a served request was given', () => {
    setState()

    expect(mount(QueuePanel).text()).toContain('120')
  })

  it('names queue states in Russian', () => {
    setState()
    const text = mount(QueuePanel).text()

    expect(text).toContain('ждёт')
    expect(text).toContain('выдано')
  })

  it('runs the scheduled job for the selected date and reports its counts', async () => {
    setState()
    const fetchMock = stub({ status: 'ok', assignedCount: 2, skippedCount: 1 })
    const wrapper = mount(QueuePanel)

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Обработать очередь'))
      .trigger('click')
    await flushPromises()

    const [url, init] = fetchMock.mock.calls[0]

    expect(url).toBe('/api/admin/jobs/process-queue')
    expect(JSON.parse(init.body)).toEqual({ date: '2026-10-09' })
    // The counts are the API's answer, not something the UI worked out.
    expect(state.notice.text).toBe('Очередь обработана: назначено 2, пропущено 1.')
  })

  it('shows the API error instead of claiming the queue ran', async () => {
    setState()
    stub({ status: 'error', error: 'Queue already processed for this date' }, 409)
    const wrapper = mount(QueuePanel)

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Обработать очередь'))
      .trigger('click')
    await flushPromises()

    expect(state.notice).toEqual({ type: 'error', text: 'Queue already processed for this date' })
  })

  it('says the queue is empty rather than rendering an empty table', () => {
    setState({ employeeRequests: [] })

    expect(mount(QueuePanel).text()).toContain('Очередь на эту дату пуста.')
  })
})
