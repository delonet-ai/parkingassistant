'use strict';

const { currentDateInTimezone, isIsoDate } = require('../../../../../packages/shared/dates');

function createDashboardController({ appTimezone, guestReserveMinimum, services }) {
  const service = services.dashboard;

  async function handleAdminDashboard(searchParams) {
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

    const { releasedPlaces, reservations, guestRequests, guestReserve } = await service.getDashboardSnapshot(date);

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        date,
        releasedPlaces: releasedPlaces.map((place) => ({
          releaseId: place.release_id,
          releaseNotes: place.release_notes,
          isReserved: Boolean(place.reservation_id),
          owner: {
            id: place.owner_user_id,
            displayName: place.owner_display_name,
            department: place.owner_department
          },
          parkingPlace: {
            id: place.parking_place_id,
            code: place.parking_place_code,
            title: place.parking_place_title,
            placeType: place.parking_place_type
          }
        })),
        reservations: reservations.map((reservation) => ({
          id: reservation.id,
          reservationDate: reservation.reservation_date,
          source: reservation.source,
          reason: reservation.reason,
          createdAt: reservation.created_at,
          user: reservation.user_id
            ? {
                id: reservation.user_id,
                displayName: reservation.user_display_name,
                department: reservation.user_department
              }
            : null,
          parkingPlace: {
            id: reservation.parking_place_id,
            code: reservation.parking_place_code,
            title: reservation.parking_place_title,
            placeType: reservation.parking_place_type
          }
        })),
        guestReserve: {
          minimum: guestReserveMinimum,
          availablePlaces: guestReserve?.available_places || 0,
          status: (guestReserve?.available_places || 0) >= guestReserveMinimum ? 'ok' : 'low'
        },
        guestRequests: guestRequests.map((request) => ({
          id: request.id,
          requestDate: request.request_date,
          status: request.status,
          guestName: request.guest_name,
          guestPhone: request.guest_phone,
          vehiclePlateNumber: request.vehicle_plate_number,
          createdAt: request.created_at,
          canceledAt: request.canceled_at,
          notes: request.notes,
          host: {
            id: request.host_user_id,
            displayName: request.host_display_name,
            department: request.host_department
          },
          assignedReservation: request.reservation_id
            ? {
                id: request.reservation_id,
                parkingPlace: {
                  id: request.parking_place_id,
                  code: request.parking_place_code,
                  title: request.parking_place_title,
                  placeType: request.parking_place_type
                }
              }
            : null
        })),
        guestReservations: reservations
          .filter((reservation) => reservation.source === 'guest')
          .map((reservation) => ({
            id: reservation.id,
            reservationDate: reservation.reservation_date,
            user: reservation.user_id
              ? {
                  id: reservation.user_id,
                  displayName: reservation.user_display_name,
                  department: reservation.user_department
                }
              : null,
            parkingPlace: {
              id: reservation.parking_place_id,
              code: reservation.parking_place_code,
              title: reservation.parking_place_title,
              placeType: reservation.parking_place_type
            }
          }))
      }
    };
  }

  async function handleAdminAvailability(searchParams) {
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

    const availability = await service.getAvailability(date);

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        availability
      }
    };
  }

  return {
    name: 'dashboard',
    routes: [
      {
        method: 'GET',
        path: '/admin/dashboard',
        advertise: true,
        handler: ({ searchParams }) => handleAdminDashboard(searchParams)
      },
      {
        method: 'GET',
        path: '/admin/availability',
        advertise: true,
        handler: ({ searchParams }) => handleAdminAvailability(searchParams)
      }
    ]
  };
}

module.exports = {
  createDashboardController
};
