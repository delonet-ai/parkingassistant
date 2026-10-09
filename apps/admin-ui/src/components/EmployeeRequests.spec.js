import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import EmployeeRequests from './EmployeeRequests.vue'
import { state } from '../store'

const REQUESTS = [
  {
    id: 'r1',
    status: 'assigned',
    notes: 'выдано из очереди',
    user: { displayName: 'Смирнова О. А.', department: 'Маркетинг' },
    queueEntry: { position: 1, status: 'assigned' },
    assignedReservation: { id: 'res1', parkingPlaceCode: '120' }
  },
  {
    id: 'r2',
    status: 'queued',
    notes: null,
    user: { displayName: 'Волков А. В.', department: 'ИТ' },
    queueEntry: { position: 2, status: 'waiting' }
  },
  {
    id: 'r3',
    status: 'canceled',
    user: { displayName: 'Морозов Е. Н.' },
    queueEntry: null
  }
]

function setState(overrides = {}) {
  Object.assign(state, {
    date: '2026-10-09',
    employeeRequests: REQUESTS,
    employees: [{ id: 'u1', displayName: 'Петров П. П.', department: 'СТМ' }],
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

describe('EmployeeRequests', () => {
  it('prints request and queue states as Russian words, not raw tokens', () => {
    setState()
    const text = mount(EmployeeRequests).text()

    expect(text).toContain('выдано')
    expect(text).toContain('в очереди')
    expect(text).toContain('отменена')
    expect(text).toContain('ждёт')
    expect(text).not.toContain('queued')
    expect(text).not.toContain('waiting')
  })

  it('shows the queue position next to its state', () => {
    setState()

    expect(mount(EmployeeRequests).text()).toContain('№2')
  })

  it('offers cancel only while a request can still be cancelled', () => {
    setState()
    const buttons = mount(EmployeeRequests)
      .findAll('button')
      .filter((button) => button.text() === 'Отменить')

    // assigned and canceled rows cannot be cancelled; queued and active can.
    expect(buttons).toHaveLength(1)
  })

  it('says the day is empty rather than rendering a headerless table', () => {
    setState({ employeeRequests: [] })

    expect(mount(EmployeeRequests).text()).toContain('На эту дату заявок сотрудников нет.')
  })

  it('posts a new request for the selected day', async () => {
    setState()
    const fetchMock = stub()
    const wrapper = mount(EmployeeRequests)

    // The create button stays disabled until an employee is chosen.
    const create = wrapper.findAll('button').find((button) => button.text().includes('Подать заявку'))
    expect(create.attributes('disabled')).toBeDefined()

    wrapper.findComponent({ name: 'ViSelect' }).vm.$emit('update:value', 'u1')
    await flushPromises()

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Подать заявку'))
      .trigger('click')
    await flushPromises()

    const [url, init] = fetchMock.mock.calls[0]

    expect(url).toBe('/api/admin/employee-parking-requests')
    expect(JSON.parse(init.body)).toEqual({
      userId: 'u1',
      requestDate: '2026-10-09',
      notes: null
    })
  })

  it('shows the API message when a duplicate request is refused', async () => {
    setState()
    stub({ status: 'error', error: 'Employee already has an active request for this date' }, 409)
    const wrapper = mount(EmployeeRequests)

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Отменить')
      .trigger('click')
    await flushPromises()

    expect(state.notice).toEqual({
      type: 'error',
      text: 'Employee already has an active request for this date'
    })
  })
})
