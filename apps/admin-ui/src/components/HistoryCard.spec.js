import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import HistoryCard from './HistoryCard.vue'
import { state } from '../store'

const HISTORY = {
  place: { id: 'p1', code: '101' },
  history: {
    permanentAssignments: [
      { id: 'a1', dateFrom: '2026-07-11', dateTo: null, notes: 'Demo', user: { displayName: 'Иванов И. И.' } }
    ],
    releases: [{ id: 'r1', dateFrom: '2026-10-09', dateTo: '2026-10-13', status: 'active', createdVia: 'admin' }],
    reservations: [],
    movements: [],
    auditLogs: [
      {
        id: 'l1',
        createdAt: '2026-10-09T08:33:54.899Z',
        action: 'permanent_assignment_created',
        entityType: 'permanent_assignment',
        actorService: 'db_seed_demo'
      }
    ]
  }
}

describe('HistoryCard', () => {
  it('renders nothing until a subject is chosen', () => {
    // ViModal ignores isOpened unless use-model is set, and then renders open — which put an
    // empty history card over the catalog on every page load. Assert the rendered result,
    // not the prop, because the prop was already false while the card was on screen.
    state.history = null
    const wrapper = mount(HistoryCard)

    expect(wrapper.findComponent({ name: 'ViModal' }).props('useModel')).toBe(true)
    expect(wrapper.text()).not.toContain('История')
    expect(wrapper.text().trim()).toBe('')
  })

  it('says it is loading rather than showing an empty card', () => {
    state.history = { kind: 'place', id: 'p1', data: null, error: null }

    expect(mount(HistoryCard).text()).toContain('Загрузка…')
  })

  it('shows the streams that have events and drops the ones that do not', () => {
    state.history = { kind: 'place', id: 'p1', data: HISTORY, error: null }
    const text = mount(HistoryCard).text()

    expect(text).toContain('История · 101')
    expect(text).toContain('Постоянные закрепления')
    expect(text).toContain('Отдачи')
    expect(text).toContain('Аудит')
    // Empty streams would otherwise be a header over an empty table.
    expect(text).not.toContain('Назначения')
    expect(text).not.toContain('Перемещения')
  })

  it('prints a timestamp as a readable moment, not as an ISO string', () => {
    state.history = { kind: 'place', id: 'p1', data: HISTORY, error: null }

    expect(mount(HistoryCard).text()).toContain('2026-10-09 08:33:54')
  })

  it('shows the API error instead of an endless loading state', () => {
    state.history = { kind: 'place', id: 'p1', data: null, error: 'Place not found' }

    expect(mount(HistoryCard).text()).toContain('Place not found')
  })

  it('says so when a subject genuinely has no events', () => {
    state.history = {
      kind: 'employee',
      id: 'u1',
      data: { employee: { displayName: 'Петров' }, history: {} },
      error: null
    }

    expect(mount(HistoryCard).text()).toContain('событий пока нет')
  })
})
