// The only place this app talks to the backend. Everything goes through the same-origin
// /api prefix: in production this app's own server proxies it, in dev vite does.
//
// No parking rule is ever evaluated here. The API decides, the UI renders what it answered —
// including the slot statuses and the warnings that come back from a write.

const BASE = '/api'

/** Both helpers resolve; a failed call is data, not an exception, so a screen can render it. */
async function request(method, path, body) {
  let response = null

  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    })
  } catch (error) {
    return { ok: false, status: 0, data: null, error: `сеть недоступна: ${error.message}` }
  }

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok) {
    // The API answers {status:'error', error, code, details}; keep the message it chose.
    return {
      ok: false,
      status: response.status,
      data,
      error: (data && data.error) || `HTTP ${response.status}`
    }
  }

  return { ok: true, status: response.status, data, error: null }
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body)
}

export function query(params) {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') {
      search.set(key, String(value))
    }
  }

  const text = search.toString()

  return text ? `?${text}` : ''
}
