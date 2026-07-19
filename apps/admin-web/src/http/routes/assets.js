'use strict';

// Non-page routes: the health probe, the floor-plan file server, the JSON proxies the
// Места tab's fetch() calls hit, and the operational place drawer the Day tab swaps in.
//
// These build their own models and answer JSON or bytes, so they sit beside the page
// route rather than inside it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { fetchJson, postJson } = require('../../api-client');
const {
  allowedMapExtensions,
  contentTypeForMap,
  mapCodeToFloorLabel,
  mapStoragePath,
  parkingMaps
} = require('../../config');
const { todayIsoDate } = require('../../components/format');
const { getPlaceOperationalState, renderOperationalPlaceCard } = require('../../components/place-card');
const { readRawBody, parseMultipartFormData } = require('../multipart');

async function buildOperationalPlaceCardModel({ selectedDate, selectedPlaceId, selectedMapCode }) {
  const [places, employees, dashboard, lineOccupancy] = await Promise.all([
    fetchJson('/admin/places'),
    fetchJson(`/admin/employees?date=${encodeURIComponent(selectedDate)}`),
    fetchJson(`/admin/dashboard?date=${encodeURIComponent(selectedDate)}`),
    fetchJson(`/admin/line-occupancy?date=${encodeURIComponent(selectedDate)}`)
  ]);

  return {
    places,
    employees,
    dashboard,
    lineOccupancy,
    selectedDate,
    selectedPlaceId,
    selectedMapCode
  };
}

/**
 * Returns true when the request was answered here, false to fall through to the next
 * route group. The order inside this function is the order the monolith used.
 */
async function handleAssetRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', service: 'admin-web' }));
    return true;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/maps/')) {
    const filename = path.basename(decodeURIComponent(url.pathname.replace('/maps/', '')));
    const extension = path.extname(filename).toLowerCase();

    if (!allowedMapExtensions.has(extension) || !/^parking-g[345]\.(png|jpg|jpeg|webp|svg)$/i.test(filename)) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', error: 'Map not found' }));
      return true;
    }

    const mapPath = path.join(mapStoragePath, filename);

    if (!fs.existsSync(mapPath)) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', error: 'Map file is not uploaded yet' }));
      return true;
    }

    res.writeHead(200, {
      'content-type': contentTypeForMap(filename),
      'cache-control': 'public, max-age=300'
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    fs.createReadStream(mapPath).pipe(res);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/admin/place-lines') {
    const result = await fetchJson(`/admin/place-lines?${url.searchParams.toString()}`);
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.data));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/admin/map-diagnostics') {
    const result = await fetchJson(`/admin/map-diagnostics?${url.searchParams.toString()}`);
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.data));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/map-backgrounds') {
    try {
      const body = await readRawBody(req);
      const form = parseMultipartFormData(req.headers['content-type'] || '', body);
      const mapCode = String(form.fields.get('mapCode') || '').trim().toLowerCase();
      const mapConfig = parkingMaps.find((map) => map.id === mapCode);
      const file = form.files.get('mapFile');

      if (!mapConfig || !file || !file.buffer.length) {
        throw new Error('Выберите карту G3/G4/G5 и файл подложки.');
      }

      const extension = path.extname(file.filename).toLowerCase();
      if (!allowedMapExtensions.has(extension)) {
        throw new Error('Поддерживаются только PNG, JPG, WEBP и SVG.');
      }

      fs.mkdirSync(mapStoragePath, { recursive: true });
      const normalizedExtension = extension === '.jpeg' ? '.jpg' : extension;
      const filename = `parking-${mapCode}${normalizedExtension}`;
      const targetPath = path.join(mapStoragePath, filename);
      fs.writeFileSync(targetPath, file.buffer);

      const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const fileType = normalizedExtension.slice(1);
      const result = await postJson('/admin/map-backgrounds', {
        mapCode,
        mapTitle: form.fields.get('mapTitle') || mapConfig.title,
        floorLabel: form.fields.get('floorLabel') || mapCodeToFloorLabel(mapCode),
        filePath: `/maps/${filename}`,
        fileType,
        sourceChecksum: checksum
      });

      if (!result.ok) {
        throw new Error(result.data?.error || `API error ${result.status}`);
      }

      res.writeHead(303, { location: `/?view=places&mapCode=${encodeURIComponent(mapCode)}&mapUploaded=1` });
      res.end();
      return true;
    } catch (error) {
      res.writeHead(303, { location: `/?view=places&error=${encodeURIComponent(error.message)}` });
      res.end();
      return true;
    }
  }

  if (
    req.method === 'POST' &&
    (url.pathname === '/admin/place-lines' || url.pathname === '/admin/place-lines/archive')
  ) {
    let payload;

    try {
      payload = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', error: 'Request body must be valid JSON' }));
      return true;
    }

    const result = await postJson(url.pathname, payload);
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.data));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/admin/operational-place-card') {
    const selectedDate = url.searchParams.get('date') || todayIsoDate();
    const selectedPlaceId = url.searchParams.get('placeId') || '';
    const requestedMapCode = url.searchParams.get('mapCode') || parkingMaps[0]?.id || 'g4';
    const selectedMapCode = parkingMaps.some((map) => map.id === requestedMapCode) ? requestedMapCode : parkingMaps[0]?.id || 'g4';

    try {
      const model = await buildOperationalPlaceCardModel({
        selectedDate,
        selectedPlaceId,
        selectedMapCode
      });
      const html = renderOperationalPlaceCard(model);
      const selected = getPlaceOperationalState(model, selectedPlaceId);

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          placeId: selected?.place?.id || null,
          html
        })
      );
      return true;
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', error: error.message }));
      return true;
    }
  }

  return false;
}

module.exports = {
  handleAssetRoutes
};
