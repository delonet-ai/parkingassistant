'use strict';

const { describeArchiveBlockers } = require('../../../../../packages/domain');
const { withTransaction } = require('../../repositories/db');
const { abortWith } = require('../../support/transaction');
const auditRepository = require('../audit/repository');
const repository = require('./repository');

function createPlaceLinesService({ pool, dbRepository }) {
  async function listPlaceLineSlots({ date, floor }) {
    return repository.listPlaceLineSlots(dbRepository, { date, floor });
  }

  // Read-only line lookups shared with the line-occupancy context, which composes the
  // /admin/line-groups endpoints on top of the same inventory.
  async function listLineGroupsWithPlaces() {
    return repository.listLineGroupsWithPlaces(dbRepository);
  }

  async function findLineGroupById(id) {
    return repository.findLineGroupById(dbRepository, id);
  }

  // The element and its slots are created in one transaction, then assign_place_lines()
  // re-derives place_type from the line capacity before the slots are read back.
  async function createLine({ capacity, code: lineCode, floorLabel, name, notes, placeType, slots }) {
    return withTransaction(pool, async (repo) => {
      const line = await repository.insertLineGroup(repo, {
        code: lineCode,
        name,
        capacity,
        floorLabel,
        notes
      });

      for (const slot of slots) {
        await repository.insertSlot(repo, {
          code: slot.code,
          title: slot.title,
          floorLabel,
          placeType,
          placeRole: slot.placeRole,
          lineGroupId: line.id,
          linePositionHint: slot.position,
          guestPriorityRank: slot.guestPriorityRank
        });
      }

      await repository.assignPlaceLines(repo);

      await auditRepository.insertAuditLog(repo, {
        entityType: 'parking_place',
        entityId: line.id,
        action: 'place_line_created',
        actorService: 'admin-web',
        metadata: {
          lineCode,
          capacity,
          floorLabel,
          slots: slots.map((slot) => ({
            code: slot.code,
            placeRole: slot.placeRole,
            guestPriorityRank: slot.guestPriorityRank
          }))
        }
      });

      return repository.listSlotsForLine(repo, line.id);
    });
  }

  // Archiving is refused while anything still points at the line, so the blocker read and
  // the two archive writes share one transaction with the row lock taken first.
  async function archiveLine({ lineId, today }) {
    return withTransaction(pool, async (repo) => {
      const line = await repository.findLineForUpdate(repo, lineId);

      if (!line || line.archived_at) {
        throw abortWith(404, 'Parking line not found');
      }

      const blockerRows = await repository.listArchiveBlockers(repo, { lineId, today });

      if (blockerRows.length > 0) {
        throw abortWith(409, 'Parking line still has active reservations or permanent assignments', {
          blockers: describeArchiveBlockers(blockerRows)
        });
      }

      const archived = await repository.archiveSlotsOfLine(repo, lineId);
      await repository.archiveLine(repo, lineId);

      await auditRepository.insertAuditLog(repo, {
        entityType: 'parking_place',
        entityId: lineId,
        action: 'place_line_archived',
        actorService: 'admin-web',
        metadata: {
          lineCode: line.code,
          capacity: line.capacity,
          floorLabel: line.floor_label,
          archivedPlaceCodes: archived.map((row) => row.code)
        }
      });

      return { line, archived };
    });
  }

  return {
    archiveLine,
    createLine,
    findLineGroupById,
    listLineGroupsWithPlaces,
    listPlaceLineSlots
  };
}

module.exports = {
  createPlaceLinesService
};
