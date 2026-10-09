// Serves the built SPA, the floor-plan images and a same-origin /api proxy to the backend.
//
// The proxy is what keeps the browser on one origin: without it the SPA would call the API
// cross-origin and the API would need CORS, which is a rule about who may talk to the
// backend and therefore not a thing to configure for the convenience of a UI.
//
// No framework and no dependency, same as the rest of the repo: node:http and node:fs.

import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const port = Number(process.env.PORT || 3100)
const apiBaseUrl = process.env.API_BASE_URL || 'http://api:3000'
const distDir = process.env.ADMIN_UI_DIST || path.join(HERE, 'dist')
const mapStoragePath = process.env.MAP_STORAGE_PATH || '/app/storage/maps'

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

/** Streams the request to the API and the answer back, headers and status included. */
async function proxyApi(req, res, url) {
  const target = new URL(`${url.pathname.replace(/^\/api/, '')}${url.search}`, apiBaseUrl)
  const chunks = []

  for await (const chunk of req) {
    chunks.push(chunk)
  }

  let upstream = null

  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : undefined,
      body: chunks.length ? Buffer.concat(chunks) : undefined
    })
  } catch (error) {
    sendJson(res, 502, { status: 'error', service: 'admin-ui', error: `api unreachable: ${error.message}` })
    return
  }

  const body = Buffer.from(await upstream.arrayBuffer())

  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'content-length': body.length
  })
  res.end(body)
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
