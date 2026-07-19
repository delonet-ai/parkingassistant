-- Place inventory redesign (Task 8).
--
-- Map-zone drawing is retired. The operator manages *elements* — parking lines holding
-- 1..3 slots — instead of rectangles on a floor plan. Three consequences for the schema:
--
--   * The regular/rotatable/blocked classification lived only inside
--     parking_place_map_zones.geometry->>'zoneType'. It is not cosmetic: 'rotatable'
--     marks the guest pool that guest allocation orders over. It is promoted to a
--     first-class parking_places.place_role column BEFORE the zone table is dropped.
--   * Element identity becomes uniform: every element, singles included, is a
--     line_groups row. That needs capacity 1 to be legal and a group backfilled for
--     every currently group-less place.
--   * line_groups.capacity becomes the source of truth for element size and
--     parking_places.place_type is derived from it. assign_place_lines() below is the
--     single implementation of that derivation, shared with the catalog import.
--
-- Step order matters: the zone table is read for data before it is dropped.
--
-- Re-runnable: every step is guarded, so applying this file twice changes nothing the
-- second time (the migration ledger already prevents it, but the guards make the file
-- safe to replay by hand against a partially migrated database).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. place_role as a first-class column.
-- ---------------------------------------------------------------------------

-- to_regtype resolves through search_path rather than matching a bare typname anywhere in
-- the catalog: the integration harness runs many scratch schemas side by side in one
-- database, and a pg_type name check would see a sibling schema's type and skip this one.
DO $$
BEGIN
  IF to_regtype('parking_place_role') IS NULL THEN
    CREATE TYPE parking_place_role AS ENUM ('regular', 'rotatable', 'blocked');
  END IF;
END $$;

ALTER TABLE parking_places
  ADD COLUMN IF NOT EXISTS place_role parking_place_role NOT NULL DEFAULT 'regular';

CREATE INDEX IF NOT EXISTS parking_places_place_role_idx
  ON parking_places (place_role)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Backfill place_role from the zone geometry, then prove nothing was lost.
--
-- A place may carry a zone on more than one floor plan (the unique constraint is
-- per map), so pick deterministically: blocked wins over rotatable wins over regular.
-- A silent loss here quietly breaks guest allocation, hence the hard assertion.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  zoned_places integer;
  roled_places integer;
BEGIN
  IF to_regclass('parking_place_map_zones') IS NULL THEN
    RETURN;
  END IF;

  UPDATE parking_places p
  SET place_role = picked.role,
      updated_at = now()
  FROM (
    SELECT DISTINCT ON (z.parking_place_id)
      z.parking_place_id,
      (z.geometry->>'zoneType')::parking_place_role AS role
    FROM parking_place_map_zones z
    WHERE z.geometry->>'zoneType' IN ('regular', 'rotatable', 'blocked')
    ORDER BY
      z.parking_place_id,
      CASE z.geometry->>'zoneType'
        WHEN 'blocked' THEN 0
        WHEN 'rotatable' THEN 1
        ELSE 2
      END,
      z.created_at
  ) AS picked
  WHERE p.id = picked.parking_place_id
    AND p.place_role IS DISTINCT FROM picked.role;

  SELECT count(DISTINCT z.parking_place_id) INTO zoned_places
  FROM parking_place_map_zones z
  WHERE z.geometry->>'zoneType' IN ('rotatable', 'blocked');

  SELECT count(*) INTO roled_places
  FROM parking_places p
  WHERE p.place_role <> 'regular';

  IF zoned_places <> roled_places THEN
    RAISE EXCEPTION
      'place_role backfill lost data: % places carried a rotatable/blocked zone but % places ended up non-regular',
      zoned_places, roled_places;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The zones are now redundant. parking_place_maps stays — the per-floor
--    background image is still shown, just as a static reference now.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS parking_place_map_zones;

-- ---------------------------------------------------------------------------
-- 4. Elements of size 1 become legal, and a line gains ordering + archival.
-- ---------------------------------------------------------------------------

ALTER TABLE line_groups
  DROP CONSTRAINT IF EXISTS line_groups_capacity_check;

ALTER TABLE line_groups
  ADD CONSTRAINT line_groups_capacity_check CHECK (capacity IN (1, 2, 3));

ALTER TABLE line_groups
  ADD COLUMN IF NOT EXISTS display_order integer,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS line_groups_display_order_idx
  ON line_groups (display_order)
  WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5-6. The one implementation of "every place belongs to a line".
--
-- Shared by this migration and scripts/import/parking-catalog.js so an import can
-- never land a place outside a line group. Idempotent: re-running it against settled
-- data changes no rows.
--
-- The rules, in order:
--   a. capacity is repaired from the real slot count where the two disagree
--      (003_infer_line_groups.sql guessed capacity from position hints and the
--      catalog does not always deliver every slot of a line).
--   b. every group-less place gets its own capacity-1 group, code line-<floor>-<code>.
--      Archived places get one too — line_group_id is NOT NULL for every row, not
--      just the active ones — and a group with no active slot is marked archived.
--   c. place_type is derived from capacity. The two must never be edited apart.
--   d. display_order sorts by floor, then the numeric prefix of the front slot's
--      code, then the code itself. parking_places.code is text and is not guaranteed
--      numeric, so non-numeric codes sort last instead of failing a cast.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assign_place_lines() RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- a. capacity follows the slots that actually exist.
  UPDATE line_groups lg
  SET capacity = actual.slot_count,
      updated_at = now()
  FROM (
    SELECT pp.line_group_id AS id, count(*)::integer AS slot_count
    FROM parking_places pp
    WHERE pp.line_group_id IS NOT NULL
      AND pp.deleted_at IS NULL
    GROUP BY pp.line_group_id
  ) AS actual
  WHERE lg.id = actual.id
    AND actual.slot_count BETWEEN 1 AND 3
    AND lg.capacity <> actual.slot_count;

  -- b. a capacity-1 group for every place that has none.
  WITH orphans AS (
    SELECT id, code, floor_label, deleted_at
    FROM parking_places
    WHERE line_group_id IS NULL
  ),
  created AS (
    INSERT INTO line_groups (code, name, capacity, floor_label, notes, archived_at)
    SELECT
      concat('line-', coalesce(o.floor_label, 'na'), '-', o.code),
      concat('Линия ', coalesce(o.floor_label, '?'), ' / ', o.code),
      1,
      o.floor_label,
      'Single-slot element',
      CASE WHEN o.deleted_at IS NULL THEN NULL ELSE now() END
    FROM orphans o
    ON CONFLICT (code) DO UPDATE
      SET updated_at = now()
    RETURNING id, code
  )
  UPDATE parking_places pp
  SET line_group_id = created.id,
      line_position_hint = 1,
      updated_at = now()
  FROM orphans o
  JOIN created
    ON created.code = concat('line-', coalesce(o.floor_label, 'na'), '-', o.code)
  WHERE pp.id = o.id;

  -- Groups that ended up with no active slot are archived, not left dangling.
  UPDATE line_groups lg
  SET archived_at = now(),
      updated_at = now()
  WHERE lg.archived_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM parking_places pp
      WHERE pp.line_group_id = lg.id
        AND pp.deleted_at IS NULL
    );

  -- c. place_type is derived from capacity, never edited independently.
  UPDATE parking_places pp
  SET place_type = derived.place_type,
      updated_at = now()
  FROM (
    SELECT
      lg.id,
      (CASE lg.capacity WHEN 1 THEN 'single' WHEN 2 THEN 'double' ELSE 'triple' END)
        ::parking_place_type AS place_type
    FROM line_groups lg
  ) AS derived
  WHERE pp.line_group_id = derived.id
    AND pp.place_type IS DISTINCT FROM derived.place_type;

  -- d. stable, human-meaningful ordering for the element list.
  UPDATE line_groups lg
  SET display_order = ordered.rn,
      updated_at = now()
  FROM (
    SELECT
      g.id,
      (row_number() OVER (
        ORDER BY
          g.floor_label NULLS LAST,
          g.numeric_prefix NULLS LAST,
          g.front_code NULLS LAST,
          g.code
      ))::integer AS rn
    FROM (
      SELECT
        lg2.id,
        lg2.code,
        lg2.floor_label,
        front.code AS front_code,
        substring(front.code from '^[0-9]+')::bigint AS numeric_prefix
      FROM line_groups lg2
      LEFT JOIN LATERAL (
        SELECT pp.code
        FROM parking_places pp
        WHERE pp.line_group_id = lg2.id
        ORDER BY pp.line_position_hint NULLS LAST, pp.code
        LIMIT 1
      ) AS front ON true
    ) AS g
  ) AS ordered
  WHERE lg.id = ordered.id
    AND lg.display_order IS DISTINCT FROM ordered.rn;
END;
$$;

SELECT assign_place_lines();

-- ---------------------------------------------------------------------------
-- 7. Make the invariant structural.
--
-- ON DELETE SET NULL contradicts NOT NULL, so the FK is switched to RESTRICT first:
-- a place silently losing its line is worse than a refused group delete.
-- ---------------------------------------------------------------------------

ALTER TABLE parking_places
  DROP CONSTRAINT IF EXISTS parking_places_line_group_id_fkey;

ALTER TABLE parking_places
  ADD CONSTRAINT parking_places_line_group_id_fkey
    FOREIGN KEY (line_group_id) REFERENCES line_groups(id) ON DELETE RESTRICT;

ALTER TABLE parking_places
  ALTER COLUMN line_group_id SET NOT NULL;

ALTER TABLE parking_places
  ALTER COLUMN line_position_hint SET DEFAULT 1;

COMMIT;
