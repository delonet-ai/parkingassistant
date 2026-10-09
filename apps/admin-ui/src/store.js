import { reactive } from 'vue'

import { api, query, setUnauthorizedHandler } from './api'

// Floor plans are static configuration; the inventory on them is not. Codes are plan ids,
// parking_places.floor_label is the bare digit — this is the one place that conversion lives.
export const FLOORS = [
  { code: 'g3', title: 'G3', floorLabel: '3' },
  { code: 'g4', title: 'G4', floorLabel: '4' },
  { code: 'g5', title: 'G5', floorLabel: '5' }
]

export const TABS = [
  { value: 'day', title: 'День' },
  { value: 'requests', title: 'Заявки' },
  { value: 'lines', title: 'Линии' },
  { value: 'catalog', title: 'Справочники' },
  { value: 'audit', title: 'Журнал' },
  { value: 'places', title: 'Места' }
]

// Ours, not the API's: the API says "Authentication required", which is true but does not
// tell the operator that the day they were working on is still there behind a sign-in.
const SESSION_ENDED = 'Сессия завершена. Войдите снова.'

export const state = reactive({
  ready: false,
  loading: false,
  bootError: null,
  view: 'day',
  // What the shell renders: 'loading' until /auth/me has answered, then the login form, the
  // first-run form, or the app. The API decides which — the UI never assumes a session.
  authStage: 'loading',
  authUser: null,
  authRoles: [],
  // The login of the single invited bootstrap user, when the database is still in that
  // state; it prefills the first-run form so the operator does not have to guess it.
  bootstrapLogin: null,
  authError: null,
  authBusy: false,
  // "Today" is the API's answer in APP_TIMEZONE, never the browser's clock: the 19:00 and
  // 07:00 rules are evaluated server-side and a browser in another zone would disagree.
  today: null,
  date: null,
  floorCode: null,
  selectedPlaceId: null,
  statusFilter: '',
  typeFilter: '',
  notice: null,
  dashboard: null,
  places: [],
  lines: [],
  employees: [],
  occupancy: [],
  employeeRequests: [],
  guestRequests: [],
  lineGroups: [],
  departurePlans: [],
  conflicts: [],
  contactAccessLogs: [],
  permanentAssignments: [],
  assignmentStatusFilter: 'all',
  auditLogs: [],
  auditFilters: { entityType: '', action: '' },
  jobRuns: { runs: [], latestSuccessfulRuns: [] },
  maps: [],
  mapDiagnostics: { placeWithoutLine: [], lineCapacityMismatch: [] },
  // One history card at a time, opened from a table: { kind: 'place'|'employee', id, data }.
  history: null
})

/**
 * The screen's address is the URL, as it was in the SSR admin: a selected place, a date, a
 * floor and a tab survive a reload and can be sent to someone else. The old UI pushed the
 * same four, and dropping them in the rewrite would have been a silent regression.
 */
const URL_KEYS = ['view', 'date', 'mapCode', 'placeId']

export function readUrl(search) {
  const params = new URLSearchParams(search)
  const view = params.get('view')

  return {
    view: TABS.some((tab) => tab.value === view) ? view : 'day',
    date: /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : null,
    floorCode: FLOORS.some((floor) => floor.code === params.get('mapCode')) ? params.get('mapCode') : null,
    selectedPlaceId: params.get('placeId') || null
  }
}

export function buildUrl() {
  const params = new URLSearchParams()
  const values = {
    view: state.view,
    date: state.date,
    mapCode: state.floorCode,
    placeId: state.selectedPlaceId
  }

  for (const key of URL_KEYS) {
    if (values[key]) {
      params.set(key, values[key])
    }
  }

  return `?${params.toString()}`
}

export function notify(type, text) {
  state.notice = { type, text }
}

export function dismissNotice() {
  state.notice = null
}

/** The first configured floor that actually holds lines — landing on an empty one reads
 * to the operator as "there are no places at all". */
export function firstPopulatedFloor(lines) {
  const populated = new Set((lines || []).map((line) => String(line.floorLabel || '')))
  const match = FLOORS.find((floor) => populated.has(floor.floorLabel))

  return match ? match.code : FLOORS[0].code
}

export function currentFloor() {
  return FLOORS.find((floor) => floor.code === state.floorCode) || FLOORS[0]
}

export async function loadDay() {
  state.loading = true

  const date = state.date ? { date: state.date } : {}
  const [
    dashboard,
    places,
    lines,
    employees,
    occupancy,
    employeeRequests,
    guestRequests,
    lineGroups,
    departurePlans,
    conflicts,
    contactAccessLogs,
    permanentAssignments,
    auditLogs,
    jobRuns,
    mapDiagnostics
  ] = await Promise.all([
      api.get(`/admin/dashboard${query(date)}`),
      api.get('/admin/places'),
      api.get(`/admin/place-lines${query(date)}`),
      api.get(`/admin/employees${query(date)}`),
      api.get(`/admin/line-occupancy${query(date)}`),
      api.get(`/admin/employee-parking-requests${query(date)}`),
      api.get(`/admin/guest-parking-requests${query(date)}`),
      api.get('/admin/line-groups'),
      api.get(`/admin/departure-plans${query(date)}`),
      api.get(`/admin/conflicts${query(date)}`),
      api.get(`/admin/contact-access-logs${query(date)}`),
      api.get(`/admin/permanent-assignments${query({ ...date, status: state.assignmentStatusFilter })}`),
      api.get(
        `/admin/audit-logs${query({ ...date, limit: 120, ...state.auditFilters })}`
      ),
      api.get('/admin/jobs/runs'),
      api.get('/admin/map-diagnostics')
    ])

  const failed = [
    dashboard,
    places,
    lines,
    employees,
    occupancy,
    employeeRequests,
    guestRequests,
    lineGroups,
    departurePlans,
    conflicts,
    contactAccessLogs,
    permanentAssignments,
    auditLogs,
    jobRuns,
    mapDiagnostics
  ].find((result) => !result.ok)
  if (failed) {
    state.loading = false
    return { ok: false, error: failed.error }
  }

  state.dashboard = dashboard.data
  state.places = places.data.places || []
  state.lines = lines.data.lines || []
  state.employees = employees.data.employees || []
  state.occupancy = occupancy.data.occupancy || []
  state.employeeRequests = employeeRequests.data.requests || []
  state.guestRequests = guestRequests.data.requests || []
  state.lineGroups = lineGroups.data.lineGroups || []
  state.departurePlans = departurePlans.data.departurePlans || []
  state.conflicts = conflicts.data.conflicts || []
  state.contactAccessLogs = contactAccessLogs.data.contactAccessLogs || []
  state.permanentAssignments = permanentAssignments.data.permanentAssignments || []
  state.auditLogs = auditLogs.data.auditLogs || []
  state.jobRuns = {
    runs: jobRuns.data.runs || [],
    latestSuccessfulRuns: jobRuns.data.latestSuccessfulRuns || []
  }
  // The floor plans are static configuration merged with what the API knows about the file
  // that was actually uploaded for each of them.
  state.maps = FLOORS.map((floor) => ({
    ...floor,
    metadata: (mapDiagnostics.data.maps || []).find((map) => map.code === floor.code) || null
  }))
  state.mapDiagnostics = mapDiagnostics.data.diagnostics || {
    placeWithoutLine: [],
    lineCapacityMismatch: []
  }
  state.today = state.today || dashboard.data.date
  state.date = state.date || dashboard.data.date

  if (!state.floorCode) {
    state.floorCode = firstPopulatedFloor(state.lines)
  }

  state.loading = false

  return { ok: true, error: null }
}

export async function boot(search = '') {
  Object.assign(state, readUrl(search))

  await resolveSession()
}

function applySession(payload) {
  const user = (payload && payload.user) || null

  state.authUser = user
  state.authRoles = (user && user.roles) || []
}

/** Boot asks the API who is signed in; the answer, not a stored flag, chooses the screen. */
async function resolveSession() {
  const me = await api.get('/auth/me')

  if (me.ok) {
    applySession(me.data)
    await enterApp()
    return
  }

  applySession(null)

  if (me.status !== 401) {
    // Not a refusal: the API is unreachable or broken. "Sign in" would blame the operator
    // for something a password cannot fix, so the login form carries the real message.
    state.authStage = 'login'
    state.authError = me.error
    return
  }

  await readBootstrapStage()
}

/**
 * Nobody is signed in, so there are two possible screens: a sign-in form, or — if the
 * database still holds only the invited bootstrap operator — the form that gives that
 * account its first password. `POST /auth/activate` enforces the same rule server-side;
 * this only decides what to show.
 */
async function readBootstrapStage() {
  const bootstrap = await api.get('/auth/bootstrap-status')
  const user = (bootstrap.ok && bootstrap.data && bootstrap.data.bootstrapUser) || null

  if (user && user.authStatus === 'invited') {
    state.bootstrapLogin = user.login
    state.authStage = 'activate'
    return
  }

  state.bootstrapLogin = null
  state.authStage = 'login'
}

/** The session resolved; the shell is this operator's, and the day loads behind it. */
async function enterApp() {
  // Set before the load, not after: a day that fails to load is a data problem the signed-in
  // operator should see inside the app, not a reason to show them a login form again.
  state.authStage = 'ready'

  const result = await loadDay()

  if (!result.ok) {
    // A 401 during the load has already dropped the UI to the login screen (see
    // `setUnauthorizedHandler` below); reporting a data failure on top of it would blame
    // the day for an expired session.
    if (state.authStage !== 'login') {
      state.bootError = result.error
    }

    return
  }

  state.bootError = null
  state.authError = null
  state.ready = true
}

export async function signIn({ login, password }) {
  state.authBusy = true
  state.authError = null

  try {
    const result = await api.post('/auth/login', { login, password })

    if (!result.ok) {
      // Whatever the API said and nothing more specific: it answers one message for a wrong
      // password and for an unknown login on purpose.
      state.authError = result.error
      return result
    }

    applySession(result.data)
    await enterApp()

    return result
  } finally {
    state.authBusy = false
  }
}

/** First run: set the bootstrap password, then use it — the operator types it once. */
export async function activateAccount({ login, password }) {
  state.authBusy = true
  state.authError = null

  try {
    const result = await api.post('/auth/activate', { login, password })

    if (!result.ok) {
      state.authError = result.error
      return result
    }

    return await signIn({ login, password })
  } finally {
    state.authBusy = false
  }
}

export async function signOut() {
  state.authBusy = true

  try {
    await api.post('/auth/logout')
  } finally {
    state.authBusy = false
  }

  endSession()
}

/** The session is gone — ended here or expired under us. Either way the screen goes back. */
export function endSession(message = null) {
  applySession(null)
  state.ready = false
  state.bootError = null
  state.notice = null
  state.history = null
  state.authStage = 'login'
  state.authError = message
}

// Registered once, at module load, so a 401 is handled even by a screen that was mounted
// without going through boot().
setUnauthorizedHandler(() => {
  if (state.authStage !== 'login') {
    endSession(SESSION_ENDED)
  }
})

export async function reloadAudit(filters) {
  state.auditFilters = { ...state.auditFilters, ...filters }
  await loadDay()
}

export async function setAssignmentFilter(value) {
  state.assignmentStatusFilter = value
  await loadDay()
}

/**
 * History is fetched on demand: a place or an employee has five streams of events behind it,
 * and loading them for every row of a 76-place catalog would be a lot of work nobody asked for.
 */
export async function openHistory({ kind, id }) {
  state.history = { kind, id, data: null, error: null }

  const path = kind === 'place' ? `/admin/places/${id}/history` : `/admin/employees/${id}/history`
  const result = await api.get(path)

  if (!state.history || state.history.id !== id) {
    return
  }

  if (!result.ok) {
    state.history = { kind, id, data: null, error: result.error }
    return
  }

  state.history = { kind, id, data: result.data, error: null }
}

export function closeHistory() {
  state.history = null
}

/** Every write goes through here: one place decides what a failure looks like, and a
 * successful write always reloads the day so the screen cannot drift from the backend. */
export async function submit(path, body, successText) {
  const result = await api.post(path, body)

  if (!result.ok) {
    notify('error', result.error)
    return result
  }

  // API warnings are objects ({type, message}), not strings — a guest placed in front of an
  // early departure arrives this way, and the operator must see it.
  const warnings = ((result.data && result.data.warnings) || []).map(
    (warning) => warning.message || warning.type || String(warning)
  )
  notify('success', warnings.length ? `${successText} Предупреждение: ${warnings.join('; ')}` : successText)
  await loadDay()

  return result
}
