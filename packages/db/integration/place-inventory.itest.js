'use strict';

// 005_place_inventory.sql: the migration that retires map zones and makes every place
// belong to a line.
//
// The interesting assertions are all about *not losing data*: place_role is promoted out
// of the zone geometry before the zone table is dropped, and nothing outside that table
// is supposed to move. So this file drives the migration by hand — it applies everything
// up to 004, plants a fixture that looks like a real pre-redesign database, and only then
// applies 005.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { MIGRATION_LOCK_KEY, plannedMigrations } = require('../migrate');
const { createTestDatabase, skipWithoutDatabase } = require('../testing/harness');

const MIGRATION_KEY = 'schema/005_place_inventory.sql';

function sqlFor(key) {
  const migration = plannedMigrations({ seed: false }).find((entry) => entry.key === key);

  if (!migration) {
    throw new Error(`migration ${key} not found`);
  }

  return migration.sql;
}

function migrationsBefore(key) {
  const planned = plannedMigrations({ seed: false });
  const index = planned.findIndex((entry) => entry.key === key);

  assert.ok(index > 0, `${key} must exist and must not be the first migration`);
  return planned.slice(0, index);
}

const FIXTURE_SQL = `
  insert into line_groups (code, name, capacity, floor_label)
  values ('line-4-101', 'Line 4 / 101', 2, '4');

  insert into parking_places (
    code, title, floor_label, place_type, line_group_id, line_position_hint, deleted_at
  )
  values
    ('101', 'Место 101', '4', 'double',
      (select id from line_groups where code = 'line-4-101'), 1, null),
    ('102', 'Место 102', '4', 'double',
      (select id from line_groups where code = 'line-4-101'), 2, null),
    -- group-less on purpose: the single that the migration has to adopt
    ('120', 'Место 120', '4', 'single', null, null, null),
    -- group-less AND archived: line_group_id becomes NOT NULL for every row, not just
    -- the active ones, so this row has to be adopted too — into an archived line.
    ('130', 'Место 130', '4', 'single', null, null, now()),
    -- non-numeric code: display_order must sort it last instead of failing a cast
    ('G-annex', 'Место G-annex', '4', 'single', null, null, null);

  insert into parking_place_maps (code, title, floor_label, file_type, file_path)
  values ('g4', 'Паркинг G4', '4', 'png', 'parking-g4.png');

  insert into parking_place_map_zones (
    parking_place_map_id, parking_place_id, zone_key, geometry
  )
  select
    (select id from parking_place_maps where code = 'g4'),
    pp.id,
    pp.code,
    jsonb_build_object('type', 'rect', 'x', 0.1, 'y', 0.1, 'width', 0.1, 'height', 0.1,
                       'zoneType', v.zone_type)
  from (
    values ('101', 'regular'), ('102', 'rotatable'), ('120', 'blocked')
  ) as v(code, zone_type)
  join parking_places pp on pp.code = v.code;

  insert into users (kind, first_name, last_name, display_name, email)
  values ('employee', 'Иван', 'Иванов', 'Иванов Иван', 'inv.001@example.invalid');

  insert into permanent_assignments (user_id, parking_place_id, valid_during)
  values (
    (select id from users where email = 'inv.001@example.invalid'),
    (select id from parking_places where code = '101'),
    daterange(current_date, null)
  );
`;

describe('005_place_inventory (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let before005 = null;

  const query = async (text, params) => (await db.query(text, params)).rows;

  const snapshotUntouched = async () => ({
    users: await query('select id, kind, display_name, email from users order by email'),
    assignments: await query(
      'select id, user_id, parking_place_id, valid_during from permanent_assignments order by id'
    ),
    maps: await query('select id, code, title, floor_label, file_path from parking_place_maps order by code'),
    placeIdentity: await query(
      'select id, code, title, floor_label, guest_priority_rank, is_active, deleted_at from parking_places order by code'
    )
  });

  before(async () => {
    db = await createTestDatabase({ apply: false });

    const client = await db.pool.connect();
    try {
      // CREATE EXTENSION is database-wide and not atomic; the runner serializes on this
      // lock and so must a hand-rolled apply running alongside the other test files.
      await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      try {
        for (const migration of migrationsBefore(MIGRATION_KEY)) {
          await client.query(migration.sql);
        }
      } finally {
        await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      }

      await client.query(FIXTURE_SQL);
    } finally {
      client.release();
    }

    before005 = await snapshotUntouched();

    await db.query(sqlFor(MIGRATION_KEY));
  });

  after(async () => {
    if (db) {
      await db.drop();
    }
  });

  it('promotes the zone role onto parking_places before dropping the zones', async () => {
    const roles = await query('select code, place_role from parking_places order by code');

    assert.deepEqual(roles, [
      { code: '101', place_role: 'regular' },
      { code: '102', place_role: 'rotatable' },
      { code: '120', place_role: 'blocked' },
      { code: '130', place_role: 'regular' },
      { code: 'G-annex', place_role: 'regular' }
    ]);
  });

  it('keeps the non-regular count the zones carried — the migration asserts it too', async () => {
    // The fixture had exactly one rotatable and one blocked zone. A silent loss here is
    // what quietly breaks guest allocation, which is why 005 raises rather than warns.
    const [row] = await query(
      "select count(*)::int as total from parking_places where place_role <> 'regular'"
    );

    assert.equal(row.total, 2);
  });

  it('drops the zone table and keeps the floor plans', async () => {
    const [row] = await query(`
      select
        to_regclass('parking_place_map_zones') is null as zones_dropped,
        to_regclass('parking_place_maps') is not null as maps_kept
    `);

    assert.deepEqual(row, { zones_dropped: true, maps_kept: true });
  });

  it('leaves no place without a line group, archived ones included', async () => {
    const [row] = await query(
      'select count(*)::int as orphans from parking_places where line_group_id is null'
    );

    assert.equal(row.orphans, 0);
  });

  it('adopts each group-less place into its own single-slot line', async () => {
    const lines = await query(`
      select pp.code, lg.code as line_code, lg.capacity, pp.place_type, pp.line_position_hint
      from parking_places pp
      join line_groups lg on lg.id = pp.line_group_id
      order by pp.code
    `);

    assert.deepEqual(lines, [
      { code: '101', line_code: 'line-4-101', capacity: 2, place_type: 'double', line_position_hint: 1 },
      { code: '102', line_code: 'line-4-101', capacity: 2, place_type: 'double', line_position_hint: 2 },
      { code: '120', line_code: 'line-4-120', capacity: 1, place_type: 'single', line_position_hint: 1 },
      { code: '130', line_code: 'line-4-130', capacity: 1, place_type: 'single', line_position_hint: 1 },
      {
        code: 'G-annex',
        line_code: 'line-4-G-annex',
        capacity: 1,
        place_type: 'single',
        line_position_hint: 1
      }
    ]);
  });

  it('archives the line adopted for an already-archived place', async () => {
    const rows = await query(`
      select code, archived_at is not null as archived
      from line_groups
      order by code
    `);

    assert.deepEqual(rows, [
      { code: 'line-4-101', archived: false },
      { code: 'line-4-120', archived: false },
      { code: 'line-4-130', archived: true },
      { code: 'line-4-G-annex', archived: false }
    ]);
  });

  it('keeps capacity, slot count and place_type in agreement', async () => {
    const mismatches = await query(`
      select lg.code
      from line_groups lg
      join parking_places pp on pp.line_group_id = lg.id and pp.deleted_at is null
      group by lg.code, lg.capacity
      having count(*) <> lg.capacity
    `);

    assert.deepEqual(mismatches, []);

    const wrongType = await query(`
      select pp.code
      from parking_places pp
      join line_groups lg on lg.id = pp.line_group_id
      where pp.place_type <>
        (case lg.capacity when 1 then 'single' when 2 then 'double' else 'triple' end)
          ::parking_place_type
    `);

    assert.deepEqual(wrongType, []);
  });

  it('orders lines by floor, numeric code prefix, then code — non-numeric last', async () => {
    const rows = await query(
      'select code from line_groups order by display_order'
    );

    assert.deepEqual(
      rows.map((row) => row.code),
      ['line-4-101', 'line-4-120', 'line-4-130', 'line-4-G-annex']
    );

    const [gaps] = await query(
      'select count(*)::int as unset from line_groups where display_order is null'
    );

    assert.equal(gaps.unset, 0);
  });

  it('makes the every-place-has-a-line rule structural', async () => {
    const [nullable] = await query(`
      select is_nullable
      from information_schema.columns
      where table_name = 'parking_places' and column_name = 'line_group_id'
    `);

    assert.equal(nullable.is_nullable, 'NO');

    const [fk] = await query(`
      select rc.delete_rule
      from information_schema.referential_constraints rc
      join information_schema.table_constraints tc
        on tc.constraint_name = rc.constraint_name
       and tc.constraint_schema = rc.constraint_schema
      where tc.table_name = 'parking_places'
        and tc.constraint_name = 'parking_places_line_group_id_fkey'
    `);

    // RESTRICT, not SET NULL: a place silently losing its line is worse than a refused
    // group delete — and SET NULL would contradict the NOT NULL above outright.
    assert.equal(fk.delete_rule, 'RESTRICT');
  });

  it('accepts capacity 1 and still refuses 0 and 4', async () => {
    await db.query(
      "insert into line_groups (code, name, capacity, floor_label) values ('line-4-900', 'x', 1, '4')"
    );

    for (const capacity of [0, 4]) {
      await assert.rejects(
        () =>
          db.query(
            "insert into line_groups (code, name, capacity, floor_label) values ($1, 'x', $2, '4')",
            [`line-4-90${capacity}`, capacity]
          ),
        /line_groups_capacity_check/
      );
    }

    // A slot-less line would be archived by the next apply, which would make the
    // idempotency assertion below fail for a reason that has nothing to do with 005.
    await db.query("delete from line_groups where code = 'line-4-900'");
  });

  it('touches nothing outside the zone table', async () => {
    assert.deepEqual(await snapshotUntouched(), before005);
  });

  it('is idempotent — applying it a second time changes nothing', async () => {
    const stateSql = `
      select
        (select count(*) from parking_places) as places,
        (select count(*) from line_groups) as lines,
        (select jsonb_agg(x order by x->>'code')
           from (
             select jsonb_build_object(
               'code', pp.code,
               'role', pp.place_role,
               'type', pp.place_type,
               'line', lg.code,
               'position', pp.line_position_hint
             ) as x
             from parking_places pp join line_groups lg on lg.id = pp.line_group_id
           ) s) as places_state,
        (select jsonb_agg(y order by y->>'code')
           from (
             select jsonb_build_object(
               'code', code, 'capacity', capacity, 'display_order', display_order,
               'archived', archived_at is not null
             ) as y
             from line_groups
           ) s) as lines_state
    `;

    const [firstState] = await query(stateSql);

    await db.query(sqlFor(MIGRATION_KEY));

    const [secondState] = await query(stateSql);

    assert.deepEqual(secondState, firstState);
  });
});
