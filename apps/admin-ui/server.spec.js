// @vitest-environment node
//
// A node environment, not happy-dom: this spec drives the real HTTP server over the loopback
// and happy-dom's fetch applies the browser's same-origin policy to it.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The proxy is the only part of this app that is not a Vue component, and the session makes it
// load-bearing: the cookie has to cross it in both directions. A spec that stubbed `fetch`
// would prove nothing here, so this one runs the real server.js against a stub API.
//
// Starting the real process also proves the import of packages/shared/multipart.js resolves:
// that file is CommonJS and this package is ESM, so a broken export shape would leave the
// floor-plan upload throwing on `readRawBody` — which no mounted component could ever notice.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BOUNDARY = '----pa-spec-boundary'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let api = null
let received = []
let child = null
let baseUrl = ''
let mapStorage = ''

/** Builds a body the way the browser does: CRLF everywhere, a closing delimiter with `--`. */
function multipartBody(parts) {
  const chunks = []

  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`

    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n\r\n`, 'utf8'))
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value, 'utf8'))
    chunks.push(Buffer.from('\r\n', 'utf8'))
  }

  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'))

  return Buffer.concat(chunks)
}

function startStubApi() {
  return new Promise((resolve) => {
    api = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) {
        chunks.push(chunk)
      }

      received.push({
        url: req.url,
        cookie: req.headers.cookie || null,
        contentType: req.headers['content-type'] || null,
        body: Buffer.concat(chunks).toString('utf8')
      })

      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': ['pa_session=token-value; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200', 'extra=1; Path=/']
      })
      res.end(JSON.stringify({ status: 'ok', service: 'api' }))
    })

    api.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${api.address().port}`))
  })
}

function startUi(apiBaseUrl) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(HERE, 'server.js')], {
      env: {
        ...process.env,
        PORT: '0',
        API_BASE_URL: apiBaseUrl,
        // The upload writes the file before telling the API about it; never into /app/storage.
        MAP_STORAGE_PATH: mapStorage
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const timer = setTimeout(() => reject(new Error('admin-ui server did not announce a port')), 10000)

    child.stdout.on('data', (chunk) => {
      const match = /listening on port (\d+)/.exec(String(chunk))

      if (match) {
        clearTimeout(timer)
        resolve(`http://127.0.0.1:${match[1]}`)
      }
    })
    child.on('error', reject)
  })
}

beforeAll(async () => {
  mapStorage = mkdtempSync(path.join(os.tmpdir(), 'pa-maps-'))
  baseUrl = await startUi(await startStubApi())
}, 20000)

afterAll(async () => {
  if (child) {
    child.kill('SIGTERM')
  }
  if (api) {
    await new Promise((resolve) => api.close(resolve))
  }
})

describe('admin-ui proxy', () => {
  it('carries the session cookie upstream', async () => {
    received = []

    const response = await fetch(`${baseUrl}/api/admin/dashboard`, {
      headers: { cookie: 'pa_session=the-token' }
    })

    expect(response.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0].cookie).toBe('pa_session=the-token')
    expect(received[0].url).toBe('/admin/dashboard')
  })

  it('returns every set-cookie the API sent, unjoined', async () => {
    received = []

    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'sysadmin', password: 'a-real-password' })
    })

    expect(response.status).toBe(200)
    // Without this the login answers 200, this process eats the cookie, and the next
    // request is anonymous.
    expect(response.headers.getSetCookie()).toEqual([
      'pa_session=token-value; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200',
      'extra=1; Path=/'
    ])
    expect(received[0].contentType).toBe('application/json')
  })
})

describe('admin-ui floor-plan upload', () => {
  it('parses the multipart body, stores the file and tells the API where it landed', async () => {
    received = []

    const response = await fetch(`${baseUrl}/api/admin/map-backgrounds`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, cookie: 'pa_session=the-token' },
      body: multipartBody([
        { name: 'mapCode', value: 'g4' },
        { name: 'mapTitle', value: 'Этаж G4' },
        { name: 'mapFile', filename: 'plan.png', value: PNG }
      ])
    })

    expect(response.status).toBe(200)

    // The file itself never reaches the API: it goes to the shared storage directory, byte for
    // byte, and the API is told the path and the checksum of what was written.
    expect([...readFileSync(path.join(mapStorage, 'parking-g4.png'))]).toEqual([...PNG])

    expect(received).toHaveLength(1)
    expect(received[0].url).toBe('/admin/map-backgrounds')
    expect(received[0].contentType).toBe('application/json')
    expect(received[0].cookie).toBe('pa_session=the-token')
    expect(JSON.parse(received[0].body)).toEqual({
      mapCode: 'g4',
      mapTitle: 'Этаж G4',
      floorLabel: '4',
      filePath: '/maps/parking-g4.png',
      fileType: 'png',
      sourceChecksum: createHash('sha256').update(PNG).digest('hex')
    })
  })

  it('refuses an upload that names no floor, without calling the API', async () => {
    received = []

    const response = await fetch(`${baseUrl}/api/admin/map-backgrounds`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: multipartBody([{ name: 'mapFile', filename: 'plan.png', value: PNG }])
    })

    expect(response.status).toBe(400)
    expect(received).toHaveLength(0)
  })

  // Both are mistakes in the request, and the generic handler would report either as
  // "Internal server error" — which tells the operator to call someone instead of sending a
  // smaller file.
  it('refuses a body past the limit with 413 rather than a server error', async () => {
    received = []

    const response = await fetch(`${baseUrl}/api/admin/map-backgrounds`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: multipartBody([
        { name: 'mapCode', value: 'g4' },
        { name: 'mapFile', filename: 'plan.png', value: Buffer.alloc(13 * 1024 * 1024) }
      ])
    })

    expect(response.status).toBe(413)
    expect((await response.json()).error).toMatch(/МБ/)
    expect(received).toHaveLength(0)
  })

  it('refuses a body that is not a multipart form with 400 rather than a server error', async () => {
    received = []

    const response = await fetch(`${baseUrl}/api/admin/map-backgrounds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapCode: 'g4' })
    })

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/форма/)
    expect(received).toHaveLength(0)
  })

  it('refuses a proxied body past the limit with 413, before the API is contacted', async () => {
    received = []

    const response = await fetch(`${baseUrl}/api/admin/catalog-import`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: Buffer.alloc(13 * 1024 * 1024)
    })

    expect(response.status).toBe(413)
    // The point of the limit: this process answers without having held the body for the API,
    // which has not even been asked whether the caller has a session.
    expect(received).toHaveLength(0)
  })

  it('refuses a file type no floor plan may have', async () => {
    received = []

    const response = await fetch(`${baseUrl}/api/admin/map-backgrounds`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: multipartBody([
        { name: 'mapCode', value: 'g4' },
        { name: 'mapFile', filename: 'plan.svg', value: PNG }
      ])
    })

    expect(response.status).toBe(400)
    expect(received).toHaveLength(0)
  })
})
