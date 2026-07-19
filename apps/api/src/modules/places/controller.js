'use strict';

const { isValidPlaceType, normalizePlaceRole } = require('../../../../../packages/domain');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { mapAuditLog } = require('../../serializers/audit-logs');
const { normalizeOptionalString } = require('../../support/params');

function createPlacesController({ services }) {
  const service = services.places;

  async function handleAdminPlacesList() {
    try {
      const places = await service.listPlacesWithOwnerAndLine();

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          places: places.map((place) => ({
            id: place.id,
            code: place.code,
            title: place.title,
            floorLabel: place.floor_label,
            placeType: place.place_type,
            placeRole: place.place_role,
            linePositionHint: place.line_position_hint,
            guestPriorityRank: place.guest_priority_rank,
            isActive: place.is_active,
            permanentOwner: place.owner_user_id
              ? {
                  id: place.owner_user_id,
                  displayName: place.owner_display_name,
                  department: place.owner_department
                }
              : null,
            lineGroup: place.line_group_id
              ? {
                  id: place.line_group_id,
                  code: place.line_group_code,
                  name: place.line_group_name,
                  capacity: place.line_group_capacity
                }
              : null
          }))
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

  async function handleAdminParkingPlaceUpdate(req) {
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

    const placeId = body.placeId;
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const floorLabel = normalizeOptionalString(body.floorLabel);
    const placeType = body.placeType;
    const lineGroupId = normalizeOptionalString(body.lineGroupId);
    const linePositionHint = body.linePositionHint ? Number(body.linePositionHint) : null;
    const guestPriorityRank = body.guestPriorityRank ? Number(body.guestPriorityRank) : null;
    // Absent placeRole means "leave it alone" — the field is optional on this endpoint.
    const placeRole = normalizePlaceRole(body.placeRole, null);

    if (!placeId || !code || !title || !isValidPlaceType(placeType)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'placeId, code, title and placeType(single|double|triple) are required'
        }
      };
    }

    if (linePositionHint !== null && (linePositionHint < 1 || linePositionHint > 3)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'linePositionHint must be between 1 and 3'
        }
      };
    }

    try {
      const place = await service.updatePlace({
        placeId,
        code,
        title,
        floorLabel,
        placeType,
        lineGroupId,
        linePositionHint,
        guestPriorityRank,
        placeRole
      });

      if (!place) {
        return {
          statusCode: 404,
          payload: {
            status: 'error',
            service: 'api',
            error: 'Parking place not found'
          }
        };
      }

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          place
        }
      };
    } catch (error) {
      if (error.code === '23505') {
        return {
          statusCode: 409,
          payload: {
            status: 'error',
            service: 'api',
            error: 'Parking place with the same code already exists'
          }
        };
      }

      if (error.code === '23503') {
        return {
          statusCode: 404,
          payload: {
            status: 'error',
            service: 'api',
            error: 'Line group not found'
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

  async function handleAdminPlaceHistory(placeId) {
    const history = await service.getPlaceHistory(placeId);

    if (!history) {
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Parking place not found'
        }
      };
    }

    const { place, permanentAssignments, releases, reservations, movements, auditLogs } = history;

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        place: {
          id: place.id,
          code: place.code,
          title: place.title,
          floorLabel: place.floor_label,
          placeType: place.place_type,
          isActive: place.is_active
        },
        history: {
          permanentAssignments: permanentAssignments.map((assignment) => ({
            id: assignment.id,
            dateFrom: assignment.date_from,
            dateTo: assignment.date_to,
            createdAt: assignment.created_at,
            notes: assignment.notes,
            user: {
              id: assignment.user_id,
              displayName: assignment.display_name,
              department: assignment.department
            }
          })),
          releases: releases.map((release) => ({
            id: release.id,
            dateFrom: release.date_from,
            dateTo: release.date_to,
            status: release.status,
            createdVia: release.created_via,
            createdAt: release.created_at,
            canceledAt: release.canceled_at,
            notes: release.notes,
            user: {
              id: release.user_id,
              displayName: release.display_name,
              department: release.department
            }
          })),
          reservations: reservations.map((reservation) => ({
            id: reservation.id,
            reservationDate: reservation.reservation_date,
            source: reservation.source,
            status: reservation.status,
            reason: reservation.reason,
            createdAt: reservation.created_at,
            canceledAt: reservation.canceled_at,
            user: reservation.user_id
              ? {
                  id: reservation.user_id,
                  displayName: reservation.display_name,
                  department: reservation.department
                }
              : null,
            guestParkingRequest: reservation.guest_parking_request_id
              ? {
                  id: reservation.guest_parking_request_id,
                  guestName: reservation.guest_name
                }
              : null
          })),
          movements: movements.map((movement) => ({
            id: movement.id,
            movementDate: movement.movement_date,
            movementType: movement.movement_type,
            reason: movement.reason,
            createdAt: movement.created_at,
            fromPlaceCode: movement.from_place_code,
            toPlaceCode: movement.to_place_code,
            source: movement.source,
            userDisplayName: movement.user_display_name,
            guestName: movement.guest_name
          })),
          auditLogs: auditLogs.map(mapAuditLog)
        }
      }
    };
  }

  return {
    name: 'places',
    routes: [
      {
        method: 'GET',
        path: '/admin/places',
        advertise: true,
        handler: () => handleAdminPlacesList()
      },
      {
        method: 'POST',
        path: '/admin/places/update',
        advertise: true,
        handler: ({ req }) => handleAdminParkingPlaceUpdate(req)
      },
      {
        method: 'GET',
        pattern: /^\/admin\/places\/([^/]+)\/history$/,
        advertise: '/admin/places/:id/history',
        safe: true,
        handler: ({ params }) => handleAdminPlaceHistory(params[0])
      }
    ]
  };
}

module.exports = {
  createPlacesController
};
