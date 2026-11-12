'use strict';

const { PayloadTooLargeError, readJsonBody } = require('../../../../../packages/shared/http');
const { mapParkingPlaceMap, mapPlanMarkup } = require('../../serializers/maps');
const { AbortTransaction } = require('../../support/transaction');
const { readMarkupDocument } = require('./markup');
const { internalError } = require('../../support/http-errors');
const { requestActor } = require('../../support/actor');

// Same shape admin-ui serves from: a single file-name segment, with no separators, no `%`
// escapes and no leading dot. The `/maps/` prefix is the path the browser asks for; the bare
// name is what the demo seeds hold.
const MAP_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isLocalMapPath(filePath) {
  const name = filePath.startsWith('/maps/') ? filePath.slice('/maps/'.length) : filePath;

  return MAP_FILE_NAME.test(name);
}

// A markup document is a few hundred polygons plus the editor's rows; 2 MB leaves room for a
// large floor without letting the route hold an unbounded body.
const MARKUP_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

function errorResult(statusCode, error, extra = {}) {
  return { statusCode, payload: { status: 'error', service: 'api', error, ...extra } };
}

function createMapsController({ services }) {
  const service = services.maps;

  async function handleMarkupGet(searchParams) {
    const mapCode = String(searchParams.get('mapCode') || '').trim().toLowerCase();

    if (!mapCode) {
      return errorResult(400, 'mapCode is required');
    }

    try {
      const markup = await service.getMarkup(mapCode);

      return { statusCode: 200, payload: { status: 'ok', service: 'api', markup: mapPlanMarkup(markup) } };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleMarkupGet');
    }
  }

  async function handleMarkupSave(req, actor) {
    let body;

    try {
      body = await readJsonBody(req, MARKUP_BODY_LIMIT_BYTES);
    } catch (error) {
      return error instanceof PayloadTooLargeError
        ? errorResult(413, 'Request body is too large')
        : errorResult(400, 'Request body must be valid JSON');
    }

    const document = readMarkupDocument(body);

    if (document.error) {
      return errorResult(400, document.error, document.details ? { details: document.details } : {});
    }

    try {
      const markup = await service.saveMarkup({ actor, ...document.value });

      return { statusCode: 200, payload: { status: 'ok', service: 'api', markup: mapPlanMarkup(markup) } };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleMarkupSave');
    }
  }

  // Inventory diagnostics for the Места tab.
  //
  // The floor plan is a static reference image and carries no data, so nothing about it
  // can be diagnosed. What can still drift is the line invariant: every place belongs to
  // a line, and a line's capacity equals the number of active slots in it.
  async function handleAdminMapDiagnostics(searchParams) {
    const mapCode = searchParams.get('mapCode');

    const { maps, placeWithoutLine, lineCapacityMismatch } = await service.getMapDiagnostics(mapCode);

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        maps: maps.map(mapParkingPlaceMap),
        diagnostics: {
          placeWithoutLine: placeWithoutLine.map((item) => ({
            parkingPlace: {
              id: item.id,
              code: item.code,
              title: item.title,
              floorLabel: item.floor_label,
              placeType: item.place_type
            }
          })),
          lineCapacityMismatch: lineCapacityMismatch.map((item) => ({
            lineId: item.id,
            code: item.code,
            name: item.name,
            floorLabel: item.floor_label,
            capacity: item.capacity,
            slotCount: item.slot_count
          }))
        }
      }
    };
  }

  async function handleAdminMapBackgroundUpdate(req, actor) {
    let body;

    try {
      body = await readJsonBody(req);
    } catch {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Request body must be valid JSON'
        }
      };
    }

    const mapCode = typeof body.mapCode === 'string' ? body.mapCode.trim().toLowerCase() : '';
    const mapTitle = typeof body.mapTitle === 'string' ? body.mapTitle.trim() : mapCode.toUpperCase();
    const floorLabel = typeof body.floorLabel === 'string' ? body.floorLabel.trim() : mapCode.replace(/^g/i, '');
    const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : '';
    const fileType = typeof body.fileType === 'string' ? body.fileType.trim().toLowerCase() : '';
    const sourceChecksum = typeof body.sourceChecksum === 'string' ? body.sourceChecksum.trim() : '';

    if (!mapCode || !filePath || !fileType || !sourceChecksum) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'mapCode, filePath, fileType and sourceChecksum are required'
        }
      };
    }

    if (!['pdf', 'svg', 'png', 'jpg', 'webp'].includes(fileType)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'fileType must be one of pdf, svg, png, jpg, webp'
        }
      };
    }

    // The stored path ends up as an image source in every operator's browser, so it must name a
    // file in admin-ui's own map volume and nothing else: `//host/x`, `https://host/x` or an
    // unrelated absolute path would turn one admin's upload into a request everyone else makes.
    if (!isLocalMapPath(filePath)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'filePath must name a map file, optionally prefixed with /maps/'
        }
      };
    }

    try {
      const map = await service.updateMapBackground({
        actor,
        mapCode,
        mapTitle: mapTitle || mapCode.toUpperCase(),
        floorLabel: floorLabel || mapCode.replace(/^g/i, ''),
        fileType,
        filePath,
        sourceChecksum
      });

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          map: mapParkingPlaceMap(map)
        }
      };
    } catch (error) {
      return internalError(error, 'handleAdminMapBackgroundUpdate');
    }
  }

  return {
    name: 'maps',
    routes: [
      {
        method: 'GET',
        path: '/admin/map-diagnostics',
        advertise: true,
        handler: ({ searchParams }) => handleAdminMapDiagnostics(searchParams)
      },
      {
        method: 'POST',
        path: '/admin/map-backgrounds',
        advertise: true,
        handler: (context) => handleAdminMapBackgroundUpdate(context.req, requestActor(context))
      },
      {
        method: 'GET',
        path: '/admin/map-markup',
        handler: ({ searchParams }) => handleMarkupGet(searchParams)
      },
      {
        method: 'POST',
        path: '/admin/map-markup',
        handler: (context) => handleMarkupSave(context.req, requestActor(context))
      }
    ]
  };
}

module.exports = {
  createMapsController
};
