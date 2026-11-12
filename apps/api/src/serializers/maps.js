'use strict';

// Row → JSON for parking_place_maps. The floor plan is a static reference image, so the
// serializer carries no geometry — see ADR 004.

function mapParkingPlaceMap(row) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    floorLabel: row.floor_label,
    fileType: row.file_type,
    filePath: row.file_path,
    sourceChecksum: row.source_checksum,
    version: row.version,
    isActive: row.is_active,
    updatedAt: row.updated_at
  };
}

// Row → JSON for a floor-plan markup document (ADR 008). `planChanged` tells the UI the plan
// image was replaced after the polygons were drawn, so they may no longer sit on the stalls.
function mapPlanMarkup(row) {
  if (!row) {
    return null;
  }

  return {
    mapCode: row.map_code,
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    places: row.places,
    editor: row.editor,
    revision: row.revision,
    sourceChecksum: row.source_checksum,
    mapChecksum: row.map_checksum,
    planChanged: Boolean(row.source_checksum && row.map_checksum && row.source_checksum !== row.map_checksum),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by_id
      ? { id: row.updated_by_id, login: row.updated_by_login, displayName: row.updated_by_display_name }
      : null
  };
}

module.exports = {
  mapParkingPlaceMap,
  mapPlanMarkup
};
