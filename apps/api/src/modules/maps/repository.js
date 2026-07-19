'use strict';

// Maps context — the per-floor plan images. Since the zone geometry was retired
// (ADR 004) a map is a static reference picture and nothing else: no click targets,
// no coordinates. All that is left is upload/replace and the diagnostics that read
// the inventory the plan is supposed to depict.

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

module.exports = {
  listMaps,
  upsertMapBackground
};
