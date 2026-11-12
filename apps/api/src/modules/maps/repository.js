'use strict';

// Maps context — the per-floor plan images, and (ADR 008) the markup drawn over them: one
// document per plan holding where each place is drawn. The markup is presentation keyed by
// the inventory; it never adds, removes or classifies a place (ADR 004 still holds).

async function listMaps(db, mapCode) {
  return db.queryMany(
    `
      select
        ppm.id,
        ppm.code,
        ppm.title,
        ppm.floor_label,
        ppm.file_type,
        ppm.file_path,
        ppm.source_checksum,
        ppm.version,
        ppm.is_active,
        ppm.updated_at
      from parking_place_maps ppm
      ${mapCode ? 'where ppm.code = $1' : ''}
      order by ppm.floor_label nulls last, ppm.code
    `,
    mapCode ? [mapCode] : []
  );
}

async function upsertMapBackground(db, { mapCode, mapTitle, floorLabel, fileType, filePath, sourceChecksum }) {
  return db.queryOne(
    `
      insert into parking_place_maps (
        code,
        title,
        floor_label,
        file_type,
        file_path,
        source_checksum,
        version
      )
      values ($1, $2, $3, $4::map_file_type, $5, $6, 1)
      on conflict (code)
      do update set
        title = excluded.title,
        floor_label = excluded.floor_label,
        file_type = excluded.file_type,
        file_path = excluded.file_path,
        source_checksum = excluded.source_checksum,
        version = parking_place_maps.version + 1,
        is_active = true,
        updated_at = now()
      returning id, code, title, floor_label, file_type, file_path, source_checksum, version, is_active, updated_at
    `,
    [mapCode, mapTitle, floorLabel, fileType, filePath, sourceChecksum]
  );
}

// The map row, locked, so two markup saves on one floor serialize on it.
async function lockMapByCode(db, mapCode) {
  return db.queryOne(
    `
      select id, code, title, floor_label, source_checksum, version
      from parking_place_maps
      where code = $1
      for update
    `,
    [mapCode]
  );
}

async function findMarkupByMapCode(db, mapCode) {
  return db.queryOne(
    `
      select
        ppm.code as map_code,
        ppm.source_checksum as map_checksum,
        m.image_width,
        m.image_height,
        m.places,
        m.editor,
        m.source_checksum,
        m.revision,
        m.updated_at,
        au.id as updated_by_id,
        au.login as updated_by_login,
        au.display_name as updated_by_display_name
      from parking_place_maps ppm
      join parking_place_map_markup m on m.map_id = ppm.id
      left join auth_users au on au.id = m.updated_by_auth_user_id
      where ppm.code = $1
    `,
    [mapCode]
  );
}

async function findMarkupRevision(db, mapId) {
  return db.queryOne('select revision from parking_place_map_markup where map_id = $1', [mapId]);
}

async function upsertMarkup(db, { mapId, imageWidth, imageHeight, places, editor, sourceChecksum, authUserId }) {
  return db.queryOne(
    `
      insert into parking_place_map_markup (
        map_id, image_width, image_height, places, editor, source_checksum, updated_by_auth_user_id
      )
      values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
      on conflict (map_id)
      do update set
        image_width = excluded.image_width,
        image_height = excluded.image_height,
        places = excluded.places,
        editor = excluded.editor,
        source_checksum = excluded.source_checksum,
        updated_by_auth_user_id = excluded.updated_by_auth_user_id,
        revision = parking_place_map_markup.revision + 1,
        updated_at = now()
      returning revision
    `,
    [mapId, imageWidth, imageHeight, JSON.stringify(places), JSON.stringify(editor), sourceChecksum, authUserId]
  );
}

// The places a markup names, with what the save has to check about each.
async function listPlacesForMarkup(db, placeIds) {
  return db.queryMany(
    `
      select id, code, floor_label, deleted_at
      from parking_places
      where id = any($1::uuid[])
    `,
    [placeIds]
  );
}

module.exports = {
  findMarkupByMapCode,
  findMarkupRevision,
  listMaps,
  listPlacesForMarkup,
  lockMapByCode,
  upsertMarkup,
  upsertMapBackground
};
