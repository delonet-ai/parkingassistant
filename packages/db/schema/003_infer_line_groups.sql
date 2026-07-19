-- Infers multi-slot lines (capacity 2 and 3) from the catalog's position hints.
--
-- This file predates the place-inventory redesign and is deliberately left as it was:
-- it is already recorded in the migration ledger of every existing database, so editing
-- its behaviour would only ever affect fresh ones and the two would drift apart.
--
-- What it does NOT do, and what 005_place_inventory.sql's assign_place_lines() does
-- instead, for both fresh and existing databases:
--
--   * single places also need a line group — capacity 1 is illegal until 005 relaxes
--     the CHECK, so it cannot be done here;
--   * parking_places.place_type is derived from line_groups.capacity rather than
--     guessed from the spreadsheet wording;
--   * line_groups.display_order is filled in.
--
-- scripts/import/parking-catalog.js applies the same front/middle/rear rule as this file
-- to the batch it stages and then calls assign_place_lines() to finish the job.

BEGIN;

WITH numbered_places AS (
  SELECT
    id,
    code,
    floor_label,
    line_position_hint,
    code::integer AS numeric_code
  FROM parking_places
  WHERE deleted_at IS NULL
    AND line_position_hint IS NOT NULL
    AND code ~ '^[0-9]+$'
),
line_candidates AS (
  SELECT
    front.id AS front_place_id,
    second.id AS second_place_id,
    CASE
      WHEN second.line_position_hint = 2 AND third.id IS NOT NULL THEN third.id
      ELSE NULL
    END AS third_place_id,
    front.floor_label,
    front.code AS front_code,
    CASE
      WHEN second.line_position_hint = 2 AND third.id IS NOT NULL THEN 3
      ELSE 2
    END AS capacity
  FROM numbered_places front
  JOIN numbered_places second
    ON second.floor_label IS NOT DISTINCT FROM front.floor_label
    AND second.numeric_code = front.numeric_code + 1
    AND second.line_position_hint IN (2, 3)
  LEFT JOIN numbered_places third
    ON third.floor_label IS NOT DISTINCT FROM front.floor_label
    AND third.numeric_code = front.numeric_code + 2
    AND third.line_position_hint = 3
  WHERE front.line_position_hint = 1
),
upserted_groups AS (
  INSERT INTO line_groups (
    code,
    name,
    capacity,
    floor_label,
    notes
  )
  SELECT
    concat('line-', floor_label, '-', front_code),
    concat('Line ', floor_label, ' / ', front_code),
    capacity,
    floor_label,
    'Inferred from parking catalog position hints'
  FROM line_candidates
  ON CONFLICT (code) DO UPDATE
    SET capacity = excluded.capacity,
        floor_label = excluded.floor_label,
        updated_at = now()
  RETURNING id, code
),
candidate_places AS (
  SELECT
    concat('line-', floor_label, '-', front_code) AS line_code,
    front_place_id AS parking_place_id,
    1 AS position
  FROM line_candidates
  UNION ALL
  SELECT
    concat('line-', floor_label, '-', front_code) AS line_code,
    second_place_id AS parking_place_id,
    2 AS position
  FROM line_candidates
  UNION ALL
  SELECT
    concat('line-', floor_label, '-', front_code) AS line_code,
    third_place_id AS parking_place_id,
    3 AS position
  FROM line_candidates
  WHERE third_place_id IS NOT NULL
)
UPDATE parking_places pp
SET
  line_group_id = lg.id,
  line_position_hint = cp.position,
  updated_at = now()
FROM candidate_places cp
JOIN upserted_groups lg ON lg.code = cp.line_code
WHERE pp.id = cp.parking_place_id;

COMMIT;
