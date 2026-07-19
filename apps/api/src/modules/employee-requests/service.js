'use strict';

const { withTransaction } = require('../../repositories/db');
const { AbortTransaction, abortWith } = require('../../support/transaction');
const auditRepository = require('../audit/repository');
const employeesRepository = require('../employees/repository');
const permanentAssignmentsRepository = require('../permanent-assignments/repository');
const queueRepository = require('../queue/repository');
const repository = require('./repository');

function createEmployeeRequestsService({ pool, dbRepository }) {
  async function listRequestsForDate(requestDate) {
    return repository.listRequestsForDate(dbRepository, requestDate);
  }

  // The queue for the date is locked first: the position the new entry gets is read with
  // `nextQueuePosition` and two concurrent requests would otherwise be handed the same one.
  async function createRequest({ userId, requestDate, notes }) {
    return withTransaction(pool, async (repo) => {
      await queueRepository.lockEmployeeQueueForDate(repo, requestDate);

      const employee = await employeesRepository.findEmployeeById(repo, userId);

      if (!employee) {
        throw abortWith(404, 'Employee not found');
      }

      const permanentAssignment = await permanentAssignmentsRepository.findActiveAssignmentForUserDate(repo, {
        userId,
        date: requestDate
      });

      if (permanentAssignment) {
        throw abortWith(409, 'Employee has a permanent parking place for the selected date');
      }

      const parkingRequest = await repository.insertRequest(repo, { userId, requestDate, notes });

      const position = await queueRepository.nextQueuePosition(repo, requestDate);
      const queuePosition = Number(position.next_position);

      const queueEntry = await queueRepository.insertQueueEntry(repo, {
        employeeParkingRequestId: parkingRequest.id,
        queueDate: requestDate,
        queuePosition
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'employee_parking_request',
        entityId: parkingRequest.id,
        action: 'employee_parking_request_created',
        actorService: 'admin-web',
        metadata: {
          userId,
          userDisplayName: employee.display_name,
          requestDate,
          queueEntryId: queueEntry.id,
          queuePosition
        }
      });

      return { employee, parkingRequest, queueEntry };
    });
  }

  // Cancelling the request and cancelling its waiting queue entries is one unit: a
  // request left in the queue after its cancellation would still win a place.
  async function cancelRequest(requestId) {
    return withTransaction(pool, async (repo) => {
      const parkingRequest = await repository.findRequestForUpdate(repo, requestId);

      if (!parkingRequest) {
        throw abortWith(404, 'Employee parking request not found');
      }

      if (parkingRequest.assigned_reservation_id) {
        throw abortWith(409, 'Assigned requests cannot be canceled here yet');
      }

      // Cancelling an already-canceled request answers 200 with the request as it
      // stands. It aborts rather than returns so the transaction rolls back, exactly
      // as the monolith did.
      if (parkingRequest.status === 'canceled') {
        throw new AbortTransaction({
          statusCode: 200,
          payload: {
            status: 'ok',
            service: 'api',
            request: {
              id: parkingRequest.id,
              requestDate: parkingRequest.request_date,
              status: parkingRequest.status
            }
          }
        });
      }

      const canceledRequest = await repository.cancelRequest(repo, requestId);
      await queueRepository.cancelWaitingEntriesForRequest(repo, requestId);

      await auditRepository.insertAuditLog(repo, {
        entityType: 'employee_parking_request',
        entityId: requestId,
        action: 'employee_parking_request_canceled',
        actorService: 'admin-web',
        metadata: {
          requestDate: parkingRequest.request_date,
          userDisplayName: parkingRequest.user_display_name
        }
      });

      return canceledRequest;
    });
  }

  return {
    cancelRequest,
    createRequest,
    listRequestsForDate
  };
}

module.exports = {
  createEmployeeRequestsService
};
