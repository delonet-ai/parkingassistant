// Place statuses, carried over from the SSR UI unchanged.
//
// Status is never conveyed by colour alone: every slot prints the word too, so the list
// stays readable for colour-blind operators and in print. The seven statuses come from the
// API (`/admin/place-lines` → slots[].status); this module only decides how they look,
// mapping each to a Vision UI palette group instead of the old hand-picked hexes.

const PLACE_STATUSES = [
  { status: 'free', label: 'свободно', group: 'green' },
  { status: 'released', label: 'отдано', group: 'mint' },
  { status: 'owner', label: 'у владельца', group: 'blue' },
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
    backgroundColor: `var(--vi-color-${group}-200)`,
    textColor: `var(--vi-color-${group}-900)`
  }
}

// Where a reservation came from is the second thing the operator reads after the place code,
// and it was plain grey text in a table. Same vocabulary as the slot statuses: a word, a
// colour, and the colour never carries the meaning on its own.
const RESERVATION_SOURCES = [
  { source: 'manual', label: 'ручное', group: 'blue' },
  { source: 'auto', label: 'авто', group: 'mint' },
  { source: 'queue', label: 'очередь', group: 'purple' },
  { source: 'guest', label: 'гость', group: 'orange' },
  { source: 'permanent', label: 'постоянное', group: 'gray' }
]

const BY_SOURCE = new Map(RESERVATION_SOURCES.map((entry) => [entry.source, entry]))

export function sourceLabel(source) {
  const entry = BY_SOURCE.get(source)

  return entry ? entry.label : source || '—'
}

export function sourceColors(source) {
  const entry = BY_SOURCE.get(source)
  const group = entry ? entry.group : 'gray'

  return {
    backgroundColor: `var(--vi-color-${group}-200)`,
    textColor: `var(--vi-color-${group}-900)`
  }
}

export function positionLabel(capacity, position) {
  const labels = POSITION_LABELS[capacity]

  return labels ? labels[position - 1] || `позиция ${position}` : ''
}

// Request and queue states, in the same two-channel form as the place statuses: a Russian
// word plus a colour. The SSR tab printed the raw English token for both.
const REQUEST_STATES = [
  { state: 'active', label: 'подана', group: 'blue' },
  { state: 'queued', label: 'в очереди', group: 'purple' },
  { state: 'assigned', label: 'выдано', group: 'green' },
  { state: 'canceled', label: 'отменена', group: 'gray' }
]

const QUEUE_STATES = [
  { state: 'waiting', label: 'ждёт', group: 'purple' },
  { state: 'assigned', label: 'выдано', group: 'green' },
  { state: 'skipped', label: 'пропущен', group: 'yellow' },
  { state: 'canceled', label: 'отменён', group: 'gray' }
]

function lookup(entries, state) {
  return entries.find((entry) => entry.state === state) || null
}

function tokens(entry) {
  const group = entry ? entry.group : 'gray'

  return {
    backgroundColor: `var(--vi-color-${group}-200)`,
    textColor: `var(--vi-color-${group}-900)`
  }
}

export function requestLabel(state) {
  const entry = lookup(REQUEST_STATES, state)

  return entry ? entry.label : state || '—'
}

export function requestColors(state) {
  return tokens(lookup(REQUEST_STATES, state))
}

export function queueLabel(state) {
  const entry = lookup(QUEUE_STATES, state)

  return entry ? entry.label : state || '—'
}

export function queueColors(state) {
  return tokens(lookup(QUEUE_STATES, state))
}
