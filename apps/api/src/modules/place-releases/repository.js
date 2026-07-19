'use strict';

// Place releases context — an owner handing their permanent place back for a day range.
// A released place is what the queue and the guest pool draw from, so every read here
// filters `pp.deleted_at is null`: an archived place must not keep counting as inventory
// just because its release row survived (Task 9, defect 1).

async function listActiveReleasesForDate(db, date) {
  return db.queryMany(
    `
      select
        pr.id as release_id,
        pr.notes as release_notes,
        u.id as owner_user_id,
        u.display_name as owner_display_name,
        u.department as owner_department,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type as parking_place_type,
        r.id as reservation_id
      from place_releases pr
      join users u on u.id = pr.user_id
      join parking_places pp on pp.id = pr.parking_place_id
        and pp.deleted_at is null
      left join reservations r
        on r.parking_place_id = pp.id
        and r.reservation_date = $1::date
        and r.status = 'active'
      where pr.status = 'active'
        and pr.release_during @> $1::date
      order by pp.code
    `,
    [date]
  );
}

async function countUnreservedReleasedPlaces(db, date) {
  return db.queryOne(
    `
      select count(*)::int as available_places
      from place_releases pr
      join parking_places pp on pp.id = pr.parking_place_id
        and pp.deleted_at is null
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
}

async function listReleasesInRange(db, { dateFrom, dateTo }) {
  return db.queryMany(
    `
      select
        pr.id,
        lower(pr.release_during)::date as date_from,
        (upper(pr.release_during)::date - 1) as date_to,
        pr.status,
        pr.created_via,
        pr.created_at,
        pr.notes,
        u.id as user_id,
        u.display_name as user_display_name,
        u.department as user_department,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type as parking_place_type
      from place_releases pr
      join users u on u.id = pr.user_id
      join parking_places pp on pp.id = pr.parking_place_id
      where pr.status = 'active'
        and ($1::date is null or pr.release_during && daterange($1::date, ($2::date + 1), '[)'))
      order by lower(pr.release_during), pp.code
    `,
    [dateFrom, dateTo]
  );
}


// The availability read model (`services/availability.js`) is a fold over this one row.
// It is not a context of its own — the numbers are all properties of released places.
async function summarizeAvailability(db, { date, guestReserveMinimum }) {
  return db.queryOne(
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
        and pp.deleted_at is null
      left join reservations r
        on r.parking_place_id = pp.id
        and r.reservation_date = $1::date
        and r.status = 'active'
      where pr.status = 'active'
        and pr.release_during @> $1::date
    `,
    [date, guestReserveMinimum]
  );
}


// The guest pick order: smallest element first (a guest should not occupy a triple that
// three employees could share), then the explicit guest priority rank, then code.
async function findPlaceForGuestAssignment(db, requestDate) {
  return db.queryOne(
    `
      select
        pr.id as release_id,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type
      from place_releases pr
      join parking_places pp on pp.id = pr.parking_place_id
        and pp.deleted_at is null
      left join reservations r
        on r.parking_place_id = pp.id
        and r.reservation_date = $1::date
        and r.status = 'active'
      where pr.status = 'active'
        and pr.release_during @> $1::date
        and r.id is null
      order by
        case pp.place_type
          when 'single' then 1
          when 'double' then 2
          when 'triple' then 3
          else 4
        end,
        pp.guest_priority_rank nulls last,
        pp.code
      limit 1
      for update of pr, pp
    `,
    [requestDate]
  );
}

// The queue pick order is the mirror image of the guest one: multi-slot lines first, so
// the singles are left for the guest pool.
async function listPlacesForQueueAssignment(db, queueDate) {
  return db.queryMany(
    `
      select
        pr.id as release_id,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.place_type,
        pr.user_id as owner_user_id
      from place_releases pr
      join parking_places pp on pp.id = pr.parking_place_id
        and pp.deleted_at is null
      left join reservations r
        on r.parking_place_id = pp.id
        and r.reservation_date = $1::date
        and r.status = 'active'
      where pr.status = 'active'
        and pr.release_during @> $1::date
        and r.id is null
      order by
        case pp.place_type
          when 'double' then 1
          when 'triple' then 2
          else 3
        end,
        pp.code
      for update of pr, pp
    `,
    [queueDate]
  );
}

async function findActiveReleaseForPlaceDate(db, { parkingPlaceId, reservationDate }) {
  return db.queryOne(
    `
      select
        pr.id as release_id,
        pr.user_id as owner_user_id,
        pp.code as parking_place_code
      from place_releases pr
      join parking_places pp on pp.id = pr.parking_place_id
        and pp.deleted_at is null
      where pr.parking_place_id = $1
        and pr.status = 'active'
        and pr.release_during @> $2::date
      limit 1
    `,
    [parkingPlaceId, reservationDate]
  );
}

async function findOverlappingRelease(db, { parkingPlaceId, dateFrom, dateTo }) {
  return db.queryOne(
    `
      select id
      from place_releases
      where parking_place_id = $1
        and status = 'active'
        and release_during && daterange($2::date, ($3::date + 1), '[)')
      limit 1
    `,
    [parkingPlaceId, dateFrom, dateTo]
  );
}

async function insertRelease(db, { userId, parkingPlaceId, dateFrom, dateTo, notes }) {
  return db.queryOne(
    `
      insert into place_releases (
        user_id,
        parking_place_id,
        release_during,
        created_via,
        notes
      )
      values (
        $1,
        $2,
        daterange($3::date, ($4::date + 1), '[)'),
        'admin_web',
        $5
      )
      returning
        id,
        lower(release_during)::date as date_from,
        (upper(release_during)::date - 1) as date_to,
        status,
        created_via,
        created_at
    `,
    [userId, parkingPlaceId, dateFrom, dateTo, notes]
  );
}

async function findReleaseForUpdate(db, releaseId) {
  return db.queryOne(
    `
      select
        pr.id,
        pr.parking_place_id,
        pr.user_id,
        pr.release_during,
        pr.status,
        pr.frozen_at,
        lower(pr.release_during)::date as date_from,
        (upper(pr.release_during)::date - 1) as date_to,
        u.display_name as user_display_name,
        pp.code as parking_place_code
      from place_releases pr
      join users u on u.id = pr.user_id
      join parking_places pp on pp.id = pr.parking_place_id
      where pr.id = $1
      for update
    `,
    [releaseId]
  );
}

async function cancelRelease(db, releaseId) {
  return db.queryOne(
    `
      update place_releases
      set
        status = 'canceled',
        canceled_at = now(),
        updated_at = now()
      where id = $1
      returning
        id,
        lower(release_during)::date as date_from,
        (upper(release_during)::date - 1) as date_to,
        status,
        canceled_at
    `,
    [releaseId]
  );
}

// Freezing is the state transition, not the audit row: once `frozen_at` is set the owner
// can no longer withdraw the release, so the pool the queue hands out the next morning
// cannot shrink underneath it. The `frozen_at is null` guard makes a second run a no-op.
// `status` deliberately stays 'active' — a frozen release is still a released place.
async function freezeReleasesForDate(db, targetDate) {
  return db.queryMany(
    `
      update place_releases pr
      set
        frozen_at = now(),
        updated_at = now()
      from parking_places pp
      where pp.id = pr.parking_place_id
        and pr.status = 'active'
        and pr.release_during @> $1::date
        and pr.frozen_at is null
      returning
        pr.id,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.place_type,
        pr.user_id as owner_user_id
    `,
    [targetDate]
  );
}

async function lockFreezeForDate(db, targetDate) {
  return db.queryOne('select pg_advisory_xact_lock(hashtext($1))', [`freeze_next_day:${targetDate}`]);
}

async function lockEmployeePoolForDate(db, targetDate) {
  return db.queryOne('select pg_advisory_xact_lock(hashtext($1))', [`unlock_employee_pool:${targetDate}`]);
}

async function lockManualAssignmentForDate(db, reservationDate) {
  return db.queryOne('select pg_advisory_xact_lock(hashtext($1))', [`manual_assignment:${reservationDate}`]);
}

async function listReleasesWithFrozenState(db, targetDate) {
  return db.queryMany(
    `
      select
        pr.id,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.place_type,
        pr.user_id as owner_user_id,
        pr.frozen_at
      from place_releases pr
      join parking_places pp on pp.id = pr.parking_place_id
      where pr.status = 'active'
        and pr.release_during @> $1::date
      order by pp.code
    `,
    [targetDate]
  );
}

async function listReleasesForPlace(db, placeId) {
  return db.queryMany(
    `
      select
        pr.id,
        lower(pr.release_during)::text as date_from,
        (upper(pr.release_during) - interval '1 day')::date::text as date_to,
        pr.status,
        pr.created_via,
        pr.created_at,
        pr.canceled_at,
        pr.notes,
        u.id as user_id,
        u.display_name,
        u.department
      from place_releases pr
      join users u on u.id = pr.user_id
      where pr.parking_place_id = $1
      order by lower(pr.release_during) desc, pr.created_at desc
      limit 100
    `,
    [placeId]
  );
}

async function listReleasesForUser(db, userId) {
  return db.queryMany(
    `
      select
        pr.id,
        lower(pr.release_during)::text as date_from,
        (upper(pr.release_during) - interval '1 day')::date::text as date_to,
        pr.status,
        pr.created_via,
        pr.created_at,
        pr.canceled_at,
        pr.notes,
        pp.id as parking_place_id,
        pp.code as parking_place_code
      from place_releases pr
      join parking_places pp on pp.id = pr.parking_place_id
      where pr.user_id = $1
      order by lower(pr.release_during) desc, pr.created_at desc
      limit 100
    `,
    [userId]
  );
}

module.exports = {
  cancelRelease,
  countUnreservedReleasedPlaces,
  findActiveReleaseForPlaceDate,
  findOverlappingRelease,
  findPlaceForGuestAssignment,
  findReleaseForUpdate,
  freezeReleasesForDate,
  insertRelease,
  listActiveReleasesForDate,
  listPlacesForQueueAssignment,
  listReleasesForPlace,
  listReleasesForUser,
  listReleasesInRange,
  listReleasesWithFrozenState,
  lockEmployeePoolForDate,
  lockFreezeForDate,
  lockManualAssignmentForDate,
  summarizeAvailability
};
