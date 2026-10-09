import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import ContactAccessLog from './ContactAccessLog.vue'
import { state } from '../store'

const LOGS = [
  {
    id: 'c1',
    occupancyDate: '2026-10-08',
    resolution: 'contact_shared',
    metadata: { reason: 'early_departure' },
    requester: { displayName: 'Петров П. С.', department: 'ИТ' },
    lineGroup: { code: 'line-4-101', name: 'Линия G4 / 101' }
  },
  {
    id: 'c2',
    occupancyDate: '2026-10-08T00:00:00.000Z',
    resolution: 'guest_ahead',
    metadata: null,
    requester: { displayName: 'Иванов И. И.' },
    lineGroup: null
  }
]

describe('ContactAccessLog', () => {
  it('names each outcome in Russian instead of printing the token', () => {
    Object.assign(state, { contactAccessLogs: LOGS })
    const text = mount(ContactAccessLog).text()

    expect(text).toContain('контакты выданы')
    expect(text).toContain('впереди гость')
    expect(text).not.toContain('contact_shared')
  })

  it('shows an unknown outcome as itself rather than blanking the cell', () => {
    Object.assign(state, { contactAccessLogs: [{ ...LOGS[0], resolution: 'teleported' }] })

    expect(mount(ContactAccessLog).text()).toContain('teleported')
  })

  it('prints the date as a day, not as a timestamp', () => {
    Object.assign(state, { contactAccessLogs: LOGS })
    const text = mount(ContactAccessLog).text()

    expect(text).toContain('2026-10-08')
    expect(text).not.toContain('T00:00:00')
  })

  it('translates the reasons it knows and passes through the ones it does not', () => {
    Object.assign(state, {
      contactAccessLogs: [LOGS[0], { ...LOGS[0], id: 'c3', metadata: { reason: 'custom_thing' } }]
    })
    const text = mount(ContactAccessLog).text()

    expect(text).toContain('ранний выезд')
    expect(text).toContain('custom_thing')
    expect(text).not.toContain('early_departure')
  })

  it('says nothing was asked rather than showing an empty table', () => {
    Object.assign(state, { contactAccessLogs: [] })

    expect(mount(ContactAccessLog).text()).toContain('Запросов контактов не было.')
  })
})
