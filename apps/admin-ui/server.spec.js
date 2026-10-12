// @vitest-environment node
//
// A node environment, not happy-dom: this spec drives the real HTTP server over the loopback
// and happy-dom's fetch applies the browser's same-origin policy to it.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
// How the stub answers the next upload: 'ok', 'slow' (the answer arrives after a beat, which
// is what lets a second upload of the same floor overlap the first) or 'hang-up' (the request
// is read and the socket dropped, which is a committed write whose answer never came back).
let uploadBehaviour = 'ok'

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

      // The one refusal the upload has to survive: the real API answers an anonymous write 401.
      if (req.url === '/admin/map-backgrounds' && !req.headers.cookie) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ status: 'error', service: 'api', error: 'Authentication required' }))
        return
      }

      if (req.url === '/admin/map-backgrounds' && uploadBehaviour === 'hang-up') {
        // The row is written and the answer is lost: the body above is already in `received`,
        // so as far as the API is concerned this upload happened.
        req.socket.destroy()
        return
      }

      if (req.url === '/admin/map-backgrounds' && uploadBehaviour === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }

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
    // byte, and the API is told the path and the checksum of what was written. The name is a
    // fresh one per upload, so the path the API records is read back from the request it got.
    const stored = readdirSync(mapStorage).filter((name) => name.startsWith('parking-g4-'))

    expect(stored).toHaveLength(1)
    expect([...readFileSync(path.join(mapStorage, stored[0]))]).toEqual([...PNG])

    expect(received).toHaveLength(1)
    expect(received[0].url).toBe('/admin/map-backgrounds')
    expect(received[0].contentType).toBe('application/json')
    expect(received[0].cookie).toBe('pa_session=the-token')
    expect(JSON.parse(received[0].body)).toEqual({
      mapCode: 'g4',
      mapTitle: 'Этаж G4',
      floorLabel: '4',
      filePath: `/maps/${stored[0]}`,
      fileType: 'png',
      sourceChecksum: createHash('sha256').update(PNG).digest('hex')
    })
  })

  it('leaves the stored plan alone when the API refuses the write', async () => {
    received = []
    const stored = path.join(mapStorage, 'parking-g5-already-there.png')
    writeFileSync(stored, PNG)

    const response = await fetch(`${baseUrl}/api/admin/map-backgrounds`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: multipartBody([
        { name: 'mapCode', value: 'g5' },
        { name: 'mapFile', filename: 'plan.png', value: Buffer.from('not the plan') }
      ])
    })

    expect(response.status).toBe(401)
    expect(received).toHaveLength(1)
    // An anonymous request must not be able to replace a floor plan by being refused after,
    // and must not leave a full-size file in the volume either.
    expect([...readFileSync(stored)]).toEqual([...PNG])
    expect(readdirSync(mapStorage).filter((name) => name.startsWith('parking-g5-'))).toEqual([
      'parking-g5-already-there.png'
    ])
  })

  it('records a path that already holds the bytes, and sweeps earlier plans of that floor', async () => {
    received = []
    // What the fixed-name uploads left behind, plus a plan of a floor this upload must not
    // touch. The record is committed last, so it can never name a file that is not there —
    // the failure a rename-after-commit had no way to undo.
    const previous = path.join(mapStorage, 'parking-g3.png')
    const otherFloor = path.join(mapStorage, 'parking-g4-keep-me.png')

    writeFileSync(previous, Buffer.from('the old plan'))
    writeFileSync(otherFloor, PNG)

    const response = await fetch(`${baseUrl}/api/admin/map-backgrounds`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, cookie: 'pa_session=the-token' },
      body: multipartBody([
        { name: 'mapCode', value: 'g3' },
        { name: 'mapFile', filename: 'plan.jpeg', value: PNG }
      ])
    })

    expect(response.status).toBe(200)

    const committed = JSON.parse(received[0].body).filePath

    expect(committed).toMatch(/^\/maps\/parking-g3-[0-9a-f-]+\.jpg$/)
    expect([...readFileSync(path.join(mapStorage, path.basename(committed)))]).toEqual([...PNG])

    // The plan this one replaces is gone — and only that one: a different extension used to
    // leave the previous file in the volume forever, and the SPA reading the old name showed it.
    expect(readdirSync(mapStorage).filter((name) => name.startsWith('parking-g3'))).toEqual([
      path.basename(committed)
    ])
    expect([...readFileSync(otherFloor)]).toEqual([...PNG])
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

  // A pdf used to be accepted and stored, and the SPA hands the recorded path to an `<img>`:
  // the browser draws nothing, and the sweep had already deleted the png the operator could
  // see before. Refused with the reason, which is what tells them to export a picture.
  it('refuses a pdf plan, which no browser would draw, with the conversion in the message', async () => {
    received = []

    const response = await fetch(`${baseUrl}/api/admin/map-backgrounds`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, cookie: 'pa_session=the-token' },
      body: multipartBody([
        { name: 'mapCode', value: 'g4' },
        { name: 'mapFile', filename: 'plan.pdf', value: PNG }
      ])
    })

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/PDF/)
    expect(received).toHaveLength(0)
    expect(readdirSync(mapStorage).some((name) => name.endsWith('.pdf'))).toBe(false)
  })

  it('keeps the plan of the upload that wins when two of the same floor overlap', async () => {
    received = []
    uploadBehaviour = 'slow'

    const upload = (value) =>
      fetch(`${baseUrl}/api/admin/map-backgrounds`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, cookie: 'pa_session=the-token' },
        body: multipartBody([
          { name: 'mapCode', value: 'g5' },
          { name: 'mapFile', filename: 'plan.png', value: Buffer.from(value) }
        ])
      })

    try {
      const [first, second] = await Promise.all([upload('plan one'), upload('plan two')])

      expect([first.status, second.status]).toEqual([200, 200])
    } finally {
      uploadBehaviour = 'ok'
    }

    const commits = received.filter((entry) => entry.url === '/admin/map-backgrounds')

    expect(commits).toHaveLength(2)

    // Whichever committed last is the row the API now holds, and its file has to be the one
    // left in the volume. Written before the queue, the second candidate was swept by the
    // first upload's sweep and the first file was then swept by the second — both uploads
    // answered 200 and the floor had no plan at all.
    const winner = path.basename(JSON.parse(commits[1].body).filePath)
    const remaining = readdirSync(mapStorage).filter((name) => name.startsWith('parking-g5-'))

    expect(remaining).toEqual([winner])
    // And it has to be the bytes that row was recorded with, not the other upload's.
    expect(createHash('sha256').update(readFileSync(path.join(mapStorage, winner))).digest('hex')).toBe(
      JSON.parse(commits[1].body).sourceChecksum
    )
  })

  it('keeps the file when the API answered and the answer was lost', async () => {
    received = []
    uploadBehaviour = 'hang-up'

    let response = null

    try {
      response = await fetch(`${baseUrl}/api/admin/map-backgrounds`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, cookie: 'pa_session=the-token' },
        body: multipartBody([
          { name: 'mapCode', value: 'g4' },
          { name: 'mapFile', filename: 'plan.png', value: Buffer.from('an answer nobody heard') }
        ])
      })
    } finally {
      uploadBehaviour = 'ok'
    }

    expect(response.status).toBe(502)

    const commits = received.filter((entry) => entry.url === '/admin/map-backgrounds')

    expect(commits).toHaveLength(1)

    // The row may well name this file — a dropped connection does not say whether the write
    // committed — so the bytes stay. Deleting them on an answer that never arrived is how the
    // record ends up ahead of the file, which is the one failure the write-first order exists
    // to prevent.
    const committed = path.basename(JSON.parse(commits[0].body).filePath)

    expect(readFileSync(path.join(mapStorage, committed)).toString('utf8')).toBe('an answer nobody heard')
  })
})
