-- Clickable floor plans (ADR 008).
--
-- ADR 004 retired the zone drawing because a zone carried no business meaning and drifted
-- away from the inventory. The markup brought back here is the opposite of that: it is
-- presentation only, keyed by the inventory it depicts. A place's polygon says where the
-- place is drawn on one floor plan image — it never decides whether the place exists, what
-- type it is or who may park there. Inventory stays in line_groups / parking_places.
--
-- One document per floor plan: the polygons by place id, plus an opaque editor state (the
-- rows the operator cut the polygons from), written whole on every save. `revision` makes
-- concurrent saves visible instead of last-writer-wins, and `source_checksum` records which
-- plan image the polygons were drawn on, so a replaced image can be flagged.
--
-- Re-runnable: guarded with IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS parking_place_map_markup (
  map_id uuid PRIMARY KEY REFERENCES parking_place_maps(id) ON DELETE CASCADE,
  image_width integer NOT NULL CHECK (image_width BETWEEN 1 AND 20000),
  image_height integer NOT NULL CHECK (image_height BETWEEN 1 AND 20000),
  places jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(places) = 'object'),
  editor jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(editor) = 'object'),
  source_checksum text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_auth_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL
);

COMMIT;
