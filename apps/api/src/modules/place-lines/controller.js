'use strict';

const { buildLineDefinition, placeSlotStatus } = require('../../../../../packages/domain');
const { currentDateInTimezone, isIsoDate } = require('../../../../../packages/shared/dates');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { normalizeOptionalString } = require('../../support/params');
const { AbortTransaction } = require('../../support/transaction');

// ---------------------------------------------------------------------------
// Place inventory (Task 9).
//
// An "element" is a parking line holding 1..3 slots: the line_groups row is the
// element, its parking_places rows are the slots. line_groups.capacity is the
// source of truth for the element size and parking_places.place_type is derived
// from it — the derivation lives in the assign_place_lines() database function
// (packages/db/schema/005_place_inventory.sql), shared with the catalog import,
// so there is exactly one implementation of the rule.
//
// These endpoints are a line-level composition over the per-place ones, not a
// parallel API: attribute edits still go to /admin/places/update, and taking a
// single slot out of service is place_role = 'blocked'. Adding and removing
// places happens here and only here — /admin/place-lines/archive is the single
// write path to parking_places.is_active.
// ---------------------------------------------------------------------------

function createPlaceLinesController({ appTimezone, services }) {
  const service = services.placeLines;

  async function handleAdminPlaceLinesList(searchParams) {
    const floor = normalizeOptionalString(searchParams.get('floor'));
    const date = searchParams.get('date') || currentDateInTimezone(appTimezone);

    if (!isIsoDate(date)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'date must use YYYY-MM-DD format'
        }
      };
    }

    const rows = await service.listPlaceLineSlots({ date, floor });

    const lines = [];
    const byLineId = new Map();

    for (const row of rows) {
      let line = byLineId.get(row.line_id);

      if (!line) {
        line = {
          lineId: row.line_id,
          code: row.line_code,
          name: row.line_name,
          capacity: row.capacity,
          floorLabel: row.floor_label,
          displayOrder: row.display_order,
          slots: []
        };
        byLineId.set(row.line_id, line);
        lines.push(line);
      }

      line.slots.push({
        placeId: row.place_id,
        code: row.place_code,
        title: row.place_title,
        placeType: row.place_type,
        position: row.line_position_hint,
        placeRole: row.place_role,
        guestPriorityRank: row.guest_priority_rank,
        status: placeSlotStatus(row),
        userDisplayName: row.user_display_name || null
      });
    }

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        date,
        floor: floor || null,
        lines
      }
    };
  }

  async function handleAdminPlaceLineCreate(req) {
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

    const definition = buildLineDefinition({
      floorLabel: normalizeOptionalString(body.floorLabel),
      capacity: body.capacity,
      slots: body.slots
    });

    if (definition.error) {
      return {
        statusCode: definition.error.statusCode,
        payload: {
          status: 'error',
          service: 'api',
          error: definition.error.error
        }
      };
    }

    const { capacity, code: lineCode, floorLabel, name, notes, placeType, slots } = definition.line;

    try {
      const stored = await service.createLine({
        capacity,
        code: lineCode,
        floorLabel,
        name,
        notes,
        placeType,
        slots
      });

      return {
        statusCode: 201,
        payload: {
          status: 'ok',
          service: 'api',
          line: {
            lineId: stored[0].line_id,
            code: stored[0].line_code,
            name: stored[0].line_name,
            capacity: stored[0].capacity,
            floorLabel: stored[0].floor_label,
            displayOrder: stored[0].display_order,
            slots: stored.map((row) => ({
              placeId: row.place_id,
              code: row.place_code,
              title: row.place_title,
              placeType: row.place_type,
              position: row.line_position_hint,
              placeRole: row.place_role,
              guestPriorityRank: row.guest_priority_rank,
              status: placeSlotStatus(row),
              userDisplayName: null
            }))
          }
        }
      };
    } catch (error) {
      if (error.code === '23505') {
        return {
          statusCode: 409,
          payload: {
            status: 'error',
            service: 'api',
            error: 'A parking place or line with the same code already exists'
          }
        };
      }

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

  async function handleAdminPlaceLineArchive(req) {
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

    const lineId = normalizeOptionalString(body.lineId);

    if (!lineId) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'lineId is required'
        }
      };
    }

    const today = currentDateInTimezone(appTimezone);

    try {
      const { line, archived } = await service.archiveLine({ lineId, today });

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          line: {
            lineId: line.id,
            code: line.code,
            capacity: line.capacity,
            floorLabel: line.floor_label
          },
          archivedPlaces: archived.map((row) => ({
            placeId: row.id,
            code: row.code,
            title: row.title
          }))
        }
      };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

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
    name: 'place-lines',
    routes: [
      {
        method: 'GET',
        path: '/admin/place-lines',
        advertise: true,
        safe: true,
        handler: ({ searchParams }) => handleAdminPlaceLinesList(searchParams)
      },
      {
        method: 'POST',
        path: '/admin/place-lines',
        handler: ({ req }) => handleAdminPlaceLineCreate(req)
      },
      {
        method: 'POST',
        path: '/admin/place-lines/archive',
        advertise: true,
        handler: ({ req }) => handleAdminPlaceLineArchive(req)
      }
    ]
  };
}

module.exports = {
  createPlaceLinesController
};
