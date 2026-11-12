'use strict';

const { withTransaction } = require('../../repositories/db');
const { auditActor } = require('../../support/actor');
const { abortWith } = require('../../support/transaction');
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
  async function updateMapBackground({ actor, mapCode, mapTitle, floorLabel, fileType, filePath, sourceChecksum }) {
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
        ...auditActor(actor),
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

  async function getMarkup(mapCode) {
    const maps = await repository.listMaps(dbRepository, mapCode);

    if (maps.length === 0) {
      throw abortWith(404, 'Floor plan not found');
    }

    return repository.findMarkupByMapCode(dbRepository, mapCode);
  }

  // The whole document is replaced on every save. `revision` is the one the caller loaded:
  // a mismatch means someone saved in between, and silently overwriting their polygons
  // would lose work nobody can see was lost.
  async function saveMarkup({ actor, mapCode, imageWidth, imageHeight, places, editor, revision }) {
    return withTransaction(pool, async (repo) => {
      const map = await repository.lockMapByCode(repo, mapCode);

      if (!map) {
        throw abortWith(404, 'Floor plan not found');
      }

      const current = await repository.findMarkupRevision(repo, map.id);
      const currentRevision = current ? current.revision : null;

      if (currentRevision !== revision) {
        throw abortWith(409, 'The plan markup was saved by someone else in the meantime — reload it and repeat your changes', {
          code: 'conflict',
          details: { currentRevision }
        });
      }

      const placeIds = Object.keys(places);
      const found = placeIds.length ? await repository.listPlacesForMarkup(repo, placeIds) : [];
      const byId = new Map(found.map((place) => [place.id, place]));
      const unknown = placeIds.filter((id) => !byId.has(id));

      if (unknown.length) {
        throw abortWith(400, 'The markup names parking places that do not exist', {
          details: { placeIds: unknown }
        });
      }

      // Archived places keep their polygon (history may still point at them) but a place from
      // another floor drawn on this plan is a mistake the operator should hear about.
      const otherFloor = found.filter((place) => String(place.floor_label) !== String(map.floor_label));

      if (otherFloor.length) {
        throw abortWith(400, `The markup names places from another floor than ${map.title}`, {
          details: { placeCodes: otherFloor.map((place) => place.code) }
        });
      }

      const saved = await repository.upsertMarkup(repo, {
        mapId: map.id,
        imageWidth,
        imageHeight,
        places,
        editor,
        sourceChecksum: map.source_checksum,
        authUserId: actor && actor.authUserId ? actor.authUserId : null
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'parking_place_map',
        entityId: map.id,
        action: 'parking_place_map_markup_saved',
        ...auditActor(actor),
        metadata: {
          mapCode,
          revision: saved.revision,
          placeCount: placeIds.length,
          sourceChecksum: map.source_checksum
        }
      });

      return repository.findMarkupByMapCode(repo, mapCode);
    });
  }

  return {
    getMapDiagnostics,
    getMarkup,
    saveMarkup,
    updateMapBackground
  };
}

module.exports = {
  createMapsService
};
