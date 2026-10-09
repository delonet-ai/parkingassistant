import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import DeparturePlans from './DeparturePlans.vue'
import { state } from '../store'

const PLANS = [
  {
    id: 'd1',
    departureTime: '15:30',
    isEarly: true,
    user: { displayName: 'Петров П. С.', department: 'ИТ' },
    lineOccupancy: { position: 2, lineGroup: { code: 'line-4-101', name: 'Линия G4 / 101' } }
  },
  {
    id: 'd2',
    departureTime: '19:00',
    isEarly: false,
    user: { displayName: 'Иванов И. И.' },
    lineOccupancy: null
  }
]

const CONFLICT = {
  type: 'employee_blocks_early_departure',
  severity: 'info',
  lineGroup: { code: 'line-4-101', name: 'Линия G4 / 101' },
  earlyDeparture: {
    departureTime: '15:30',
    position: 2,
    parkingPlaceCode: '102',
    user: { displayName: 'Петров П. С.' }
  },
  blocker: {
    position: 1,
    subjectType: 'employee',
    parkingPlaceCode: '101',
    user: { displayName: 'Иванов И. И.' }
  }
}

function setState(overrides = {}) {
  Object.assign(state, {
    date: '2026-10-09',
    departurePlans: PLANS,
    conflicts: [CONFLICT],
    employees: [{ id: 'u1', displayName: 'Петров П. С.' }],
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

describe('DeparturePlans', () => {
  it('marks an early departure in words, not only by colour', () => {
    setState()
    const text = mount(DeparturePlans).text()

    expect(text).toContain('15:30')
    expect(text).toContain('ранний выезд')
    expect(text).toContain('обычный')
  })

  it('spells out who blocks whom instead of printing the conflict type', () => {
    setState()
    const text = mount(DeparturePlans).text()

    expect(text).toContain('Петров П. С.')
    expect(text).toContain('впереди на позиции №1')
    expect(text).toContain('Иванов И. И.')
    expect(text).not.toContain('employee_blocks_early_departure')
  })

  it('names the guest when the blocker is one', () => {
    setState({
      conflicts: [
        {
          ...CONFLICT,
          blocker: {
            position: 1,
            subjectType: 'guest',
            parkingPlaceCode: '101',
            guestParkingRequest: { guestName: 'Тихонова Елена' }
          }
        }
      ]
    })

    expect(mount(DeparturePlans).text()).toContain('гость Тихонова Елена')
  })

  it('says there are no conflicts rather than showing an empty area', () => {
    setState({ conflicts: [] })

    expect(mount(DeparturePlans).text()).toContain('Конфликтов по ранним выездам на эту дату нет.')
  })

  it('renders the 07:00 lock as the API message rather than crashing', async () => {
    setState()
    stub(
      { status: 'error', error: 'Departure time for the current day can be edited only before 07:00' },
      409
    )
    const wrapper = mount(DeparturePlans)

    wrapper.findComponent({ name: 'ViSelect' }).vm.$emit('update:value', 'u1')
    // Type into the field rather than emitting at the component: the save button stays
    // disabled until the time is complete, so this also pins that guard.
    await wrapper.find('input[placeholder="18:30"]').setValue('15:30')
    await flushPromises()

    const save = wrapper.findAll('button').find((button) => button.text().includes('Сохранить'))
    expect(save.attributes('disabled')).toBeUndefined()
    await save.trigger('click')
    await flushPromises()

    expect(state.notice).toEqual({
      type: 'error',
      text: 'Departure time for the current day can be edited only before 07:00'
    })
  })

  it('posts HH:MM, not the digits the masked field emits', async () => {
    setState()
    const fetchMock = stub()
    const wrapper = mount(DeparturePlans)

    wrapper.findComponent({ name: 'ViSelect' }).vm.$emit('update:value', 'u1')
    await wrapper.find('input[placeholder="18:30"]').setValue('15:30')
    await flushPromises()

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Сохранить'))
      .trigger('click')
    await flushPromises()

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      userId: 'u1',
      planDate: '2026-10-09',
      departureTime: '15:30'
    })
  })

  it('keeps saving disabled until the time is a complete, possible one', async () => {
    setState()
    const wrapper = mount(DeparturePlans)
    const save = () => wrapper.findAll('button').find((button) => button.text().includes('Сохранить'))

    wrapper.findComponent({ name: 'ViSelect' }).vm.$emit('update:value', 'u1')
    await wrapper.find('input[placeholder="18:30"]').setValue('15')
    await flushPromises()
    expect(save().attributes('disabled')).toBe('')

    await wrapper.find('input[placeholder="18:30"]').setValue('25:00')
    await flushPromises()
    expect(save().attributes('disabled')).toBe('')

    await wrapper.find('input[placeholder="18:30"]').setValue('15:30')
    await flushPromises()
    expect(save().attributes('disabled')).toBeUndefined()
  })
})
