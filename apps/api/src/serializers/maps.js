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

module.exports = {
  mapParkingPlaceMap
};
