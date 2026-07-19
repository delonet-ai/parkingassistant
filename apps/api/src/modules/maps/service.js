'use strict';

const { withTransaction } = require('../../repositories/db');
const auditRepository = require('../audit/repository');
const placeLinesRepository = require('../place-lines/repository');
const repository = require('./repository');

function createMapsService({ pool, dbRepository }) {
  // Three sequential reads, kept in the monolith's order: the map list first, then the two
  // inventory drift checks that the Места tab renders underneath it.
  async function getMapDiagnostics(mapCode) {
    const maps = await repository.listMaps(dbRepository, mapCode);
    const placeWithoutLine = await placeLinesRepository.listPlacesWithoutLine(dbRepository);
    const lineCapacityMismatch = await placeLinesRepository.listLinesWithCapacityMismatch(dbRepository);

    return { maps, placeWithoutLine, lineCapacityMismatch };
  }

  // The upsert bumps the map version, so the audit entry has to read it back inside the
  // same transaction to record the version the caller is told about.
  async function updateMapBackground({ mapCode, mapTitle, floorLabel, fileType, filePath, sourceChecksum }) {
    return withTransaction(pool, async (repo) => {
      const map = await repository.upsertMapBackground(repo, {
        mapCode,
        mapTitle,
        floorLabel,
        fileType,
        filePath,
        sourceChecksum
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'parking_place_map',
        entityId: map.id,
        action: 'parking_place_map_background_replaced',
        actorService: 'admin-web',
        metadata: {
          mapCode,
          filePath,
          fileType,
          sourceChecksum,
          version: map.version
        }
      });

      return map;
    });
  }

  return {
    getMapDiagnostics,
    updateMapBackground
  };
}

module.exports = {
  createMapsService
};
