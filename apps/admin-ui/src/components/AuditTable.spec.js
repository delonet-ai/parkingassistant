import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AuditTable from './AuditTable.vue'
import { state } from '../store'

// Three rows, one per kind of actor the API can now record: an operator signed into the admin
// UI, an employee acting through the bot, and a scheduled job that has no person at all.
const LOGS = [
  {
    id: 'a1',
    occurredAt: '2026-10-09T08:31:00.000Z',
    action: 'manual_reservation_created',
    entityType: 'reservation',
    actorService: 'admin-ui',
    actorUser: null,
    actorAuthUser: { id: 'u1', login: 'sysadmin', displayName: 'Симонович Е. Л.' },
    metadata: { parkingPlaceCode: '120' }
  },
  {
    id: 'a2',
    occurredAt: '2026-10-09T07:10:00.000Z',
    action: 'departure_plan_upserted',
    entityType: 'departure_plan',
    actorService: 'bot',
    actorUser: { id: 'e1', displayName: 'Волков А. В.' },
    actorAuthUser: null,
    metadata: {}
  },
  {
    id: 'a3',
    occurredAt: '2026-10-08T19:00:00.000Z',
    action: 'job_freeze_next_day_success',
    entityType: 'system',
    actorService: 'jobs',
    actorUser: null,
    actorAuthUser: null,
    metadata: {}
  }
]

function setState(overrides = {}) {
  Object.assign(state, {
    date: '2026-10-09',
    auditLogs: LOGS,
    auditFilters: { entityType: '', action: '' },
    ...overrides
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AuditTable «Кто»', () => {
  it('names the signed-in operator who acted', () => {
    setState()

    expect(mount(AuditTable).text()).toContain('Симонович Е. Л.')
  })

  it('falls back to the login when the operator has no display name', () => {
    setState({ auditLogs: [{ ...LOGS[0], actorAuthUser: { id: 'u1', login: 'sysadmin', displayName: null } }] })

    expect(mount(AuditTable).text()).toContain('sysadmin')
  })

  it('names the employee behind a bot action', () => {
    setState({ auditLogs: [LOGS[1]] })
    const text = mount(AuditTable).text()

    expect(text).toContain('Волков А. В.')
    expect(text).toContain('bot')
  })

  // The point of the fallback: a job has no operator, so the service is what the column shows
  // rather than an em dash or the last person who happened to sign in.
  it('falls back to the service for a row a job wrote', () => {
    setState({ auditLogs: [LOGS[2]] })
    const text = mount(AuditTable).text()

    expect(text).toContain('jobs')
    expect(text).not.toContain('Симонович')
  })

  it('shows the application alongside the person, not instead of them', () => {
    setState({ auditLogs: [LOGS[0]] })
    const text = mount(AuditTable).text()

    expect(text).toContain('Симонович Е. Л.')
    expect(text).toContain('admin-ui')
  })
})
