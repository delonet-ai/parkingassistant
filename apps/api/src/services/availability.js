'use strict';

async function countAvailableReleasedPlaces(client, date) {
  const result = await client.query(
    `
      select count(*)::int as count
      from place_releases pr
      join parking_places pp on pp.id = pr.parking_place_id
      left join reservations r
        on r.parking_place_id = pp.id
        and r.reservation_date = $1::date
        and r.status = 'active'
      where pr.status = 'active'
        and pr.release_during @> $1::date
        and r.id is null
    `,
    [date]
  );

  return result.rows[0]?.count || 0;
}

async function calculateAvailabilitySnapshot(client, date, options) {
  const { appTimezone, guestReserveMinimum } = options;
  const result = await client.query(
    `
      select
        count(*)::int as released_places,
        count(*) filter (where r.id is null)::int as available_places,
        count(*) filter (where r.id is null and pp.place_type in ('double', 'triple'))::int as before_19_employee_places,
        greatest(count(*) filter (where r.id is null)::int - $2::int, 0)::int as after_19_employee_places,
        count(*) filter (where r.id is null and pp.place_type = 'single')::int as available_single_places,
        count(*) filter (where r.id is null and pp.place_type = 'double')::int as available_double_places,
        count(*) filter (where r.id is null and pp.place_type = 'triple')::int as available_triple_places
      from place_releases pr
      join parking_places pp on pp.id = pr.parking_place_id
      left join reservations r
        on r.parking_place_id = pp.id
        and r.reservation_date = $1::date
        and r.status = 'active'
      where pr.status = 'active'
        and pr.release_during @> $1::date
    `,
    [date, guestReserveMinimum]
  );
  const row = result.rows[0] || {};
  const availablePlaces = row.available_places || 0;

  return {
    date,
    timezone: appTimezone,
    releasedPlaces: row.released_places || 0,
    availablePlaces,
    employeeAvailability: {
      before19: row.before_19_employee_places || 0,
      after19: row.after_19_employee_places || 0
    },
    guestReserve: {
      minimum: guestReserveMinimum,
      availablePlaces,
      status: availablePlaces >= guestReserveMinimum ? 'ok' : 'low'
    },
    byType: {
      single: row.available_single_places || 0,
      double: row.available_double_places || 0,
      triple: row.available_triple_places || 0
    }
  };
}

module.exports = {
  calculateAvailabilitySnapshot,
  countAvailableReleasedPlaces
};
