'use strict';

const { readJsonBody } = require('../../../../../packages/shared/http');
const { mapParkingPlaceMap } = require('../../serializers/maps');

function createMapsController({ services }) {
  const service = services.maps;

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

  async function handleAdminMapBackgroundUpdate(req) {
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

    try {
      const map = await service.updateMapBackground({
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
      return {
        statusCode: 500,
        payload: {
          status: 'error',
          service: 'api',
          error: error.message
        }
      };
    }
  }

  return {
    name: 'maps',
    routes: [
      {
        method: 'GET',
        path: '/admin/map-diagnostics',
        advertise: true,
        safe: true,
        handler: ({ searchParams }) => handleAdminMapDiagnostics(searchParams)
      },
      {
        method: 'POST',
        path: '/admin/map-backgrounds',
        advertise: true,
        handler: ({ req }) => handleAdminMapBackgroundUpdate(req)
      }
    ]
  };
}

module.exports = {
  createMapsController
};
