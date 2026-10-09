import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import EmployeesTable from './EmployeesTable.vue'
import PermanentAssignments from './PermanentAssignments.vue'
import PlacesTable from './PlacesTable.vue'
import { state } from '../store'

const EMPLOYEES = [
  {
    id: 'u1',
    displayName: 'Иванов Иван Иванович',
    department: 'ИТ',
    email: 'ivanov@demo.invalid',
    phone: '+7 900 000-00-01',
    isActive: true,
    permanentPlace: { code: '101' }
  },
  { id: 'u2', displayName: 'Петров Пётр', department: 'СТМ', isActive: false, permanentPlace: null }
]

const PLACES = [
  {
    id: 'p1',
    code: '101',
    title: 'Место 101',
    floorLabel: '4',
    placeType: 'double',
    placeRole: 'regular',
    guestPriorityRank: null,
    lineGroup: { code: 'line-4-101' },
    permanentOwner: { displayName: 'Иванов Иван Иванович' }
  },
  {
    id: 'p2',
    code: '102',
    floorLabel: '4',
    placeType: 'double',
    placeRole: 'rotatable',
    guestPriorityRank: 3,
    lineGroup: { code: 'line-4-101' }
  }
]

const ASSIGNMENTS = [
  {
    id: 'a1',
    status: 'active',
    dateFrom: '2026-07-11',
    dateTo: null,
    notes: 'Demo',
    user: { displayName: 'Иванов Иван Иванович' },
    parkingPlace: { code: '101' }
  },
  {
    id: 'a2',
    status: 'ended',
    dateFrom: '2026-01-01',
    dateTo: '2026-06-30',
    user: { displayName: 'Петров Пётр' },
    parkingPlace: { code: '102' }
  }
]

function setState(overrides = {}) {
  Object.assign(state, {
    date: '2026-10-09',
    employees: EMPLOYEES,
    places: PLACES,
    permanentAssignments: ASSIGNMENTS,
    assignmentStatusFilter: 'all',
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

describe('EmployeesTable', () => {
  it('filters by any visible field without going to the API', async () => {
    setState()
    const fetchMock = stub()
    const wrapper = mount(EmployeesTable)

    expect(wrapper.text()).toContain('Иванов Иван Иванович')
    expect(wrapper.text()).toContain('Петров Пётр')

    await wrapper.find('input[placeholder="имя, отдел, место"]').setValue('СТМ')
    await flushPromises()

    expect(wrapper.text()).not.toContain('Иванов Иван Иванович')
    expect(wrapper.text()).toContain('Петров Пётр')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marks who is active in words and offers disable only to them', () => {
    setState()
    const wrapper = mount(EmployeesTable)

    expect(wrapper.text()).toContain('активен')
    expect(wrapper.text()).toContain('отключён')
    expect(wrapper.findAll('button').filter((button) => button.text() === 'Отключить')).toHaveLength(1)
  })

  it('asks for a history card instead of navigating away', async () => {
    setState()
    const wrapper = mount(EmployeesTable)

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Иванов Иван Иванович')
      .trigger('click')

    expect(wrapper.emitted('open-history')).toEqual([[{ kind: 'employee', id: 'u1' }]])
  })
})

describe('PlacesTable', () => {
  it('offers no place-create form — places are created on the Места tab', () => {
    setState()
    const text = mount(PlacesTable).text()

    expect(text).toContain('Места создаются и архивируются на вкладке «Места».')
    expect(mount(PlacesTable).findAll('button').map((button) => button.text())).not.toContain('Создать')
  })

  it('names the role in Russian and shows the guest rank as it is', () => {
    setState()
    const text = mount(PlacesTable).text()

    expect(text).toContain('Обычное')
    expect(text).toContain('Ротируемое/гостевое')
    expect(text).toContain('3')
  })

  it('sends only the role, so a partial update cannot overwrite the rest of the place', async () => {
    setState()
    const fetchMock = stub()
    const wrapper = mount(PlacesTable)

    wrapper.findAllComponents({ name: 'ViSelect' })[0].vm.$emit('update:value', 'blocked')
    await flushPromises()

    const [url, init] = fetchMock.mock.calls[0]

    expect(url).toBe('/api/admin/places/update')
    expect(JSON.parse(init.body)).toEqual({ placeId: 'p1', placeRole: 'blocked' })
  })
})

describe('PermanentAssignments', () => {
  it('shows an open-ended assignment as endless rather than as an empty cell', () => {
    setState()
    const text = mount(PermanentAssignments).text()

    expect(text).toContain('бессрочно')
    expect(text).toContain('активно')
    expect(text).toContain('завершено')
  })

  it('offers «завершить» to everything except an already ended assignment', () => {
    setState()

    expect(
      mount(PermanentAssignments)
        .findAll('button')
        .filter((button) => button.text() === 'Завершить')
    ).toHaveLength(1)
  })

  it('ends an assignment as of the selected day', async () => {
    setState()
    const fetchMock = stub()
    const wrapper = mount(PermanentAssignments)

    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Завершить')
      .trigger('click')
    await flushPromises()

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      assignmentId: 'a1',
      dateTo: '2026-10-09'
    })
  })
})
