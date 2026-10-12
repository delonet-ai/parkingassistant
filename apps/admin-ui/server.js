// Serves the built SPA, the floor-plan images and a same-origin /api proxy to the backend.
//
// The proxy is what keeps the browser on one origin: without it the SPA would call the API
// cross-origin and the API would need CORS, which is a rule about who may talk to the
// backend and therefore not a thing to configure for the convenience of a UI.
//
// No framework and no dependency, same as the rest of the repo: node:http and node:fs.

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The parser is shared with the API (packages/shared is CommonJS; Node's named-export
// interop is what makes this import work).
import { PayloadTooLargeError, parseMultipartFormData, readRawBody } from '../../packages/shared/multipart.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const port = Number(process.env.PORT || 3100)
const apiBaseUrl = process.env.API_BASE_URL || 'http://api:3000'
const distDir = process.env.ADMIN_UI_DIST || path.join(HERE, 'dist')
const mapStoragePath = process.env.MAP_STORAGE_PATH || '/app/storage/maps'

// How much of a request body this server will hold in memory. It buffers both the bodies it
// proxies and the plan it writes, and it does so *before* the API has authorized anything —
// so the API's own limits protect the API, not this process. Above the API's 10 MB catalog
// limit, so the refusal the operator sees is the API's reason and not this one's.
const BODY_LIMIT_BYTES = 12 * 1024 * 1024

function sendTooLarge(res) {
  // `connection: close` is not politeness: refusing at the limit abandons the request body
  // part-read, and the bytes still in flight would be parsed as the next request on a
  // keep-alive connection. Answering and closing is the only safe end to this exchange.
  const payload = JSON.stringify({
    status: 'error',
    service: 'admin-ui',
    error: `Файл больше ${Math.floor(BODY_LIMIT_BYTES / (1024 * 1024))} МБ.`
  })

  res.writeHead(413, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    connection: 'close'
  })
  res.end(payload)
}

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.pdf', 'application/pdf'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.ico', 'image/x-icon']
])

function contentType(filename) {
  return CONTENT_TYPES.get(path.extname(filename).toLowerCase()) || 'application/octet-stream'
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

async function sendFile(res, filePath) {
  const info = await stat(filePath)

  res.writeHead(200, { 'content-type': contentType(filePath), 'content-length': info.size })
  createReadStream(filePath).pipe(res)
}

/**
 * The session is a cookie, so the proxy has to be transparent in both directions: the
 * browser's `cookie` reaches the API, and the API's `set-cookie` reaches the browser.
 * Forwarding only `content-type` would make every request after a successful login
 * anonymous — the login would answer 200, hand its cookie to this process and drop it here.
 */
function upstreamHeaders(req, extra = {}) {
  const headers = {}

  if (req.headers['content-type']) {
    headers['content-type'] = req.headers['content-type']
  }

  if (req.headers.cookie) {
    headers.cookie = req.headers.cookie
  }

  // `extra` wins: the floor-plan upload arrives as multipart and leaves as JSON.
  return { ...headers, ...extra }
}

/** `set-cookie` may legitimately repeat, which `Headers.get` would join into one broken value. */
function relayHeaders(upstream, contentLength) {
  const headers = {
    'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'content-length': contentLength
  }
  const cookies =
    typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : [upstream.headers.get('set-cookie')].filter(Boolean)

  if (cookies.length) {
    headers['set-cookie'] = cookies
  }

  return headers
}

/**
 * Relays the request to the API and the answer back, headers and status included.
 *
 * The body is buffered rather than streamed, which is why it needs a limit of its own: this
 * runs before the API sees the request, so an oversized body would be held here whether or
 * not the caller has a session.
 */
async function proxyApi(req, res, url) {
  const target = new URL(`${url.pathname.replace(/^\/api/, '')}${url.search}`, apiBaseUrl)
  let requestBody = null

  try {
    requestBody = await readRawBody(req, BODY_LIMIT_BYTES)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendTooLarge(res)
      return
    }

    throw error
  }

  let upstream = null

  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: upstreamHeaders(req),
      body: requestBody.length ? requestBody : undefined
    })
  } catch (error) {
    sendJson(res, 502, { status: 'error', service: 'admin-ui', error: `api unreachable: ${error.message}` })
    return
  }

  const body = Buffer.from(await upstream.arrayBuffer())

  res.writeHead(upstream.status, relayHeaders(upstream, body.length))
  res.end(body)
}

const FLOOR_PLANS = [
  { code: 'g3', title: 'G3', floorLabel: '3' },
  { code: 'g4', title: 'G4', floorLabel: '4' },
  { code: 'g5', title: 'G5', floorLabel: '5' }
]

// What the SPA can draw, which is narrower than the `map_file_type` enum the API accepts.
// The plan is a static reference image in an `<img>` (ADR 004), so a floor plan the browser
// will not render is refused here rather than stored: the previous plan is swept once a new
// one is recorded, and a pdf would have left the floor with nothing visible at all. A pdf
// from the building management has to be saved as a raster image first — which README's
// "PDF-карты этажей нужно преобразовать в пригодный для интерфейса растровый формат" has
// always said. svg is out for the same reason it always was.
const PLAN_TYPES = new Map([
  ['.png', 'png'],
  ['.jpg', 'jpg'],
  ['.jpeg', 'jpg'],
  ['.webp', 'webp']
])

const floorPlanQueues = new Map()

/**
 * Runs `task` after every earlier task queued under `key` has settled. In-process, which is
 * enough: one admin-ui process owns the maps volume.
 */
function oneAtATime(key, task) {
  const run = (floorPlanQueues.get(key) || Promise.resolve()).then(task)
  const settled = run.catch(() => {})

  floorPlanQueues.set(key, settled)
  settled.then(() => {
    if (floorPlanQueues.get(key) === settled) {
      floorPlanQueues.delete(key)
    }
  })

  return run
}

/**
 * Deletes the floor's earlier plan files, once the API's row names a newer one.
 *
 * Best effort on purpose: the upload has already succeeded by the time this runs, and an
 * unreferenced file nobody reads is a smaller fault than a 500 over an upload that worked.
 */
async function removeSupersededPlans(mapCode, keep) {
  // `parking-g3.png` is what the fixed-name uploads left behind, `parking-g3-<uuid>.png` what
  // this server writes now; the separator keeps the pattern off every other floor's files.
  const superseded = new RegExp(`^parking-${mapCode}[-.]`)
  let names = []

  try {
    names = await readdir(mapStoragePath)
  } catch (error) {
    console.error(`admin-ui: cannot list ${mapStoragePath} to sweep earlier ${mapCode} plans`, error)
    return
  }

  for (const name of names) {
    if (name === keep || !superseded.test(name)) {
      continue
    }

    try {
      // Files only: a directory under the floor's prefix is not something this server put
      // there, so it is reported rather than removed.
      await rm(path.join(mapStoragePath, name), { force: true })
    } catch (error) {
      console.error(`admin-ui: earlier floor plan ${name} left behind`, error)
    }
  }
}

/**
 * The floor plan upload is the one request this server does more than proxy.
 *
 * The API stores metadata only — code, title, path, type and checksum — so the file itself has
 * to be written into the shared storage directory first, and the API told where it landed.
 * Carried over from admin-web, except for the one fixed filename per floor it used to
 * overwrite: every upload now writes its own name and the floor's earlier files are swept once
 * the API's row names the new one. The version in the API still records the change.
 */
async function uploadFloorPlan(req, res) {
  let form = null

  // Two faults of the request, which the generic handler would report as a server error:
  // a body past the limit and a body that is not a multipart form.
  try {
    form = parseMultipartFormData(
      req.headers['content-type'] || '',
      await readRawBody(req, BODY_LIMIT_BYTES)
    )
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendTooLarge(res)
      return
    }

    sendJson(res, 400, { status: 'error', service: 'admin-ui', error: 'Ожидается форма с файлом подложки.' })
    return
  }

  const mapCode = String(form.fields.get('mapCode') || '').trim().toLowerCase()
  const plan = FLOOR_PLANS.find((item) => item.code === mapCode)
  const file = form.files.get('mapFile')

  if (!plan || !file || !file.buffer.length) {
    sendJson(res, 400, {
      status: 'error',
      service: 'admin-ui',
      error: 'Выберите этаж G3/G4/G5 и файл подложки.'
    })
    return
  }

  const fileType = PLAN_TYPES.get(path.extname(file.filename).toLowerCase())

  if (!fileType) {
    sendJson(res, 400, {
      status: 'error',
      service: 'admin-ui',
      error: 'Поддерживаются png, jpg и webp. PDF-план нужно сохранить картинкой.'
    })
    return
  }

  // The file name carries a fresh uuid, and the bytes are in it before the API hears about
  // them. Two failures are closed by that order, and neither is closed by writing the floor's
  // one fixed name:
  //
  // This server checks no session of its own — the API does, on the call below. A plan written
  // straight into the active path would let an anonymous request replace a floor plan and only
  // then be refused. And bytes moved into place *after* the API answers leave the record ahead
  // of the file whenever that move fails: the row would name a path, a type and a checksum
  // that no file answers, and the operator's plan would be the previous one or none at all.
  //
  // A path nothing references yet has neither fault. The upload either becomes the floor's
  // plan together with the record that names it, or is deleted having been refused in so many
  // words — a refusal nobody heard leaves the bytes alone, see the catch below.
  const filename = `parking-${plan.code}-${randomUUID()}.${fileType}`
  const target = path.join(mapStoragePath, filename)

  let upstream = null
  let written = false

  try {
    // One floor at a time, from the write to the sweep below: the API keeps one row per
    // floor, so two uploads of the same floor could otherwise commit in one order and sweep in
    // the other — and the later sweep would delete the file the surviving row names.
    await oneAtATime(plan.code, async () => {
      // Inside the queue, not before it: the sweep deletes every earlier file of the floor,
      // and it cannot tell a superseded plan from a candidate another request is still
      // waiting to commit. Written ahead of the queue, this upload's bytes would be swept by
      // the upload in front of it and its own record would then name nothing.
      await mkdir(mapStoragePath, { recursive: true })
      await writeFile(target, file.buffer)
      written = true

      // The operator's session has to travel with this one too: the API refuses an anonymous
      // write, and that refusal is what keeps these bytes out of the record.
      upstream = await fetch(new URL('/admin/map-backgrounds', apiBaseUrl), {
        method: 'POST',
        headers: upstreamHeaders(req, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          mapCode: plan.code,
          mapTitle: form.fields.get('mapTitle') || plan.title,
          floorLabel: form.fields.get('floorLabel') || plan.floorLabel,
          filePath: `/maps/${filename}`,
          fileType,
          sourceChecksum: createHash('sha256').update(file.buffer).digest('hex')
        })
      })

      if (!upstream.ok) {
        // Nothing references these bytes, and a refused upload must not leave a full-size
        // plan in the shared volume forever.
        await rm(target, { force: true })
        return
      }

      await removeSupersededPlans(plan.code, filename)
    })
  } catch (error) {
    if (!written) {
      // Storage itself refused the plan, so the API was never asked and there is nothing to
      // reconcile. Not this handler's 502 either: the API is not the part that failed.
      throw error
    }

    // The candidate stays. A rejected `fetch` does not say whether the API answered: the
    // request may have been refused before it was read, or committed and the answer lost on
    // the way back. Only an explicit non-success response, handled above, proves these bytes
    // are referenced by nothing — so deleting them here would be the record-ahead-of-the-file
    // fault again, this time with no way to notice it. An unread file costs disk and is swept
    // by the floor's next successful upload; a row naming a deleted plan costs the operator
    // their plan.
    console.error(`admin-ui: floor plan ${filename} kept — the API's answer never arrived`, error)
    sendJson(res, 502, { status: 'error', service: 'admin-ui', error: `api unreachable: ${error.message}` })
    return
  }

  const payload = Buffer.from(await upstream.arrayBuffer())

  res.writeHead(upstream.status, relayHeaders(upstream, payload.length))
  res.end(payload)
}

const server = http.createServer(async (req, res) => {
  // The Host header is client-controlled and an unparseable one throws before any route
  // matches, so the base is fixed and nothing downstream reads it.
  let url = null

  try {
    url = new URL(req.url, 'http://admin-ui.local')
  } catch {
    sendJson(res, 400, { status: 'error', service: 'admin-ui', error: 'Malformed request target' })
    return
  }

  try {
    if (url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok', service: 'admin-ui' })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/map-backgrounds') {
      await uploadFloorPlan(req, res)
      return
    }

    if (url.pathname.startsWith('/api/')) {
      await proxyApi(req, res, url)
      return
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/maps/')) {
      // basename() keeps a crafted path from climbing out of the storage directory.
      const filename = path.basename(decodeURIComponent(url.pathname.slice('/maps/'.length)))
      const filePath = path.join(mapStoragePath, filename)

      if (!filename || !existsSync(filePath)) {
        sendJson(res, 404, { status: 'error', service: 'admin-ui', error: 'Map not found' })
        return
      }

      await sendFile(res, filePath)
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { status: 'error', service: 'admin-ui', error: 'Method not allowed' })
      return
    }

    const requested = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    const candidate = path.join(distDir, requested)

    if (requested !== '/' && candidate.startsWith(distDir) && existsSync(candidate)) {
      const info = await stat(candidate)
      if (info.isFile()) {
        await sendFile(res, candidate)
        return
      }
    }

    // Single-page app: any other path is a client-side route, so the shell answers.
    const shell = path.join(distDir, 'index.html')

    if (!existsSync(shell)) {
      sendJson(res, 500, { status: 'error', service: 'admin-ui', error: 'Build is missing: run npm run build' })
      return
    }

    await sendFile(res, shell)
  } catch (error) {
    console.error('admin-ui request failed', error)
    if (!res.headersSent) {
      sendJson(res, 500, { status: 'error', service: 'admin-ui', error: 'Internal server error' })
    }
  }
})

server.listen(port, '0.0.0.0', () => {
  // The bound port, not the requested one: PORT=0 lets the OS pick.
  console.log(`parkingassistant admin-ui listening on port ${server.address().port}`)
})

function shutdown(signal) {
  console.log(`received ${signal}, shutting down`)
  server.close(() => process.exit(0))
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
