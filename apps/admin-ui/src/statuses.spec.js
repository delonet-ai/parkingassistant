import { describe, expect, it } from 'vitest'

import { PLACE_STATUS_OPTIONS, positionLabel, statusColors, statusLabel } from './statuses'

describe('place statuses', () => {
  it('keeps the six statuses and their Russian words from the SSR UI', () => {
    expect(PLACE_STATUS_OPTIONS.map((option) => option.status)).toEqual([
      'free',
      'released',
      'occupied',
      'guest',
      'rotatable',
      'blocked'
    ])
    expect(PLACE_STATUS_OPTIONS.map((option) => option.label)).toEqual([
      'свободно',
      'отдано',
      'занято',
      'гостевое',
      'ротируемое',
      'недоступно'
    ])
  })

  it('prints the status word, not the raw English token', () => {
    expect(statusLabel('rotatable')).toBe('ротируемое')
  })

  it('falls back to the raw value rather than rendering nothing for an unknown status', () => {
    // A status added to the domain must show up as itself instead of disappearing.
    expect(statusLabel('reserved-by-martians')).toBe('reserved-by-martians')
    expect(statusLabel(null)).toBe('—')
  })

  it('colours every status from design-system tokens, never a hard-coded hex', () => {
    for (const option of PLACE_STATUS_OPTIONS) {
      const colors = statusColors(option.status)

      expect(colors.backgroundColor).toMatch(/^rgb\(var\(--vi-color-[a-z]+-\d+\)\)$/)
      expect(colors.textColor).toMatch(/^rgb\(var\(--vi-color-[a-z]+-\d+\)\)$/)
    }
  })

  it('names slot positions front to rear so the card mirrors the real line', () => {
    expect(positionLabel(3, 1)).toBe('перёд')
    expect(positionLabel(3, 2)).toBe('середина')
    expect(positionLabel(3, 3)).toBe('зад')
    expect(positionLabel(2, 1)).toBe('перёд')
    expect(positionLabel(1, 1)).toBe('')
  })
})
