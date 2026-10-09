import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import KpiStrip from './KpiStrip.vue'

const DASHBOARD = {
  releasedPlaces: [
    { parkingPlace: { id: 'p1' }, isReserved: false },
    { parkingPlace: { id: 'p2' }, isReserved: true }
  ],
  reservations: [{ id: 'r1' }],
  guestRequests: [],
  guestReserve: { minimum: 5, availablePlaces: 7, status: 'ok' }
}

describe('KpiStrip', () => {
  it('counts released, assignable and reserved places off the dashboard', () => {
    const text = mount(KpiStrip, { props: { dashboard: DASHBOARD } }).text()

    expect(text).toContain('Отдано мест')
    expect(text).toContain('Доступно к назначению')
    expect(text).toContain('Активных назначений')
  })

  it('takes the employee requests from their own endpoint, not from the dashboard', () => {
    // /admin/dashboard carries guest requests but no employee ones, so reading them off it
    // printed a permanent zero.
    const wrapper = mount(KpiStrip, {
      props: {
        dashboard: DASHBOARD,
        employeeRequests: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        guestRequests: [{ id: 'g' }]
      }
    })

    const tiles = wrapper.text()

    expect(tiles).toContain('Заявок сотрудников')
    expect(tiles).toContain('3')
    expect(tiles).toContain('Гостевых заявок')
  })

  it('states the guest reserve in words as well as colour', () => {
    const ok = mount(KpiStrip, { props: { dashboard: DASHBOARD } })
    const low = mount(KpiStrip, {
      props: { dashboard: { ...DASHBOARD, guestReserve: { minimum: 5, availablePlaces: 1, status: 'low' } } }
    })

    expect(ok.text()).toContain('7/5')
    expect(ok.text()).toContain('в норме')
    expect(low.text()).toContain('1/5')
    expect(low.text()).toContain('ниже минимума')
  })

  it('renders with no dashboard at all rather than throwing on first paint', () => {
    expect(mount(KpiStrip, { props: { dashboard: null } }).text()).toContain('0/5')
  })
})
