// Place statuses, carried over from the SSR UI unchanged.
//
// Status is never conveyed by colour alone: every slot prints the word too, so the list
// stays readable for colour-blind operators and in print. The six statuses come from the
// API (`/admin/place-lines` → slots[].status); this module only decides how they look,
// mapping each to a Vision UI palette group instead of the old hand-picked hexes.

const PLACE_STATUSES = [
  { status: 'free', label: 'свободно', group: 'green' },
  { status: 'released', label: 'отдано', group: 'mint' },
  { status: 'occupied', label: 'занято', group: 'yellow' },
  { status: 'guest', label: 'гостевое', group: 'orange' },
  { status: 'rotatable', label: 'ротируемое', group: 'red' },
  { status: 'blocked', label: 'недоступно', group: 'gray' }
]

const BY_STATUS = new Map(PLACE_STATUSES.map((entry) => [entry.status, entry]))

export const PLACE_STATUS_OPTIONS = PLACE_STATUSES.map(({ status, label }) => ({ status, label }))

export const PLACE_TYPE_OPTIONS = [
  { value: 'single', label: 'одинарное' },
  { value: 'double', label: 'двойное' },
  { value: 'triple', label: 'тройное' }
]

export const CAPACITY_LABELS = { 1: 'одинарное', 2: 'двойное', 3: 'тройное' }

// Slots are listed front-to-rear, so the card mirrors the real line and "who blocks whom"
// is obvious at a glance.
export const POSITION_LABELS = { 2: ['перёд', 'зад'], 3: ['перёд', 'середина', 'зад'] }

export function statusLabel(status) {
  const entry = BY_STATUS.get(status)

  return entry ? entry.label : status || '—'
}

/**
 * Vision UI nameplates take plain CSS colours and apply them as inline styles.
 *
 * The token goes in as `var(--vi-color-…)`, NOT wrapped in `rgb()`: the `--vi-color-*` layer
 * holds hex values (`#cfeed7`), while the deprecated `--vi-primary` layer holds RGB triplets.
 * `rgb(#cfeed7)` is invalid and the browser drops the declaration — which is what left the
 * first build with colourless nameplates.
 */
export function statusColors(status) {
  const entry = BY_STATUS.get(status)
  const group = entry ? entry.group : 'gray'

  return {
    backgroundColor: `var(--vi-color-${group}-100)`,
    textColor: `var(--vi-color-${group}-800)`
  }
}

export function positionLabel(capacity, position) {
  const labels = POSITION_LABELS[capacity]

  return labels ? labels[position - 1] || `позиция ${position}` : ''
}
