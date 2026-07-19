'use strict';

const auditRepository = require('../audit/repository');
const repository = require('./repository');

function createPermanentAssignmentsService({ dbRepository }) {
  async function listPermanentAssignments({ date, status }) {
    return repository.listPermanentAssignments(dbRepository, { date, status });
  }

  async function createPermanentAssignment(input) {
    const assignment = await repository.insertPermanentAssignment(dbRepository, input);

    await auditRepository.insertAuditLog(dbRepository, {
      entityType: 'permanent_assignment',
      entityId: assignment.id,
      action: 'permanent_assignment_created',
      actorService: 'admin-web',
      metadata: {
        userId: input.userId,
        parkingPlaceId: input.parkingPlaceId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        notes: input.notes
      }
    });

    return assignment;
  }

  async function endPermanentAssignment({ assignmentId, dateTo }) {
    const assignment = await repository.endPermanentAssignment(dbRepository, { assignmentId, dateTo });

    if (!assignment) {
      return null;
    }

    await auditRepository.insertAuditLog(dbRepository, {
      entityType: 'permanent_assignment',
      entityId: assignmentId,
      action: 'permanent_assignment_ended',
      actorService: 'admin-web',
      metadata: {
        userId: assignment.user_id,
        parkingPlaceId: assignment.parking_place_id,
        dateTo
      }
    });

    return assignment;
  }

  return {
    createPermanentAssignment,
    endPermanentAssignment,
    listPermanentAssignments
  };
}

module.exports = {
  createPermanentAssignmentsService
};
