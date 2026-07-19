'use strict';

const { isEarlyDeparture } = require('../../../../../packages/domain');
const { withTransaction } = require('../../repositories/db');
const { abortWith } = require('../../support/transaction');
const auditRepository = require('../audit/repository');
const employeesRepository = require('../employees/repository');
const placesRepository = require('../places/repository');
const repository = require('./repository');

function createDeparturePlansService({ pool, dbRepository, appTimezone }) {
  // Exported as well as used by the list handler: the dashboard-side readers of this
  // context go through the service, never through the repository.
  async function getPlansForDate(date) {
    const rows = await repository.listPlansForDate(dbRepository, date);

    return rows.map((row) => ({
      id: row.id,
      planDate: row.plan_date,
      departureTime: row.departure_time.slice(0, 5),
      isEarly: row.is_early,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      user: {
        id: row.user_id,
        displayName: row.display_name,
        department: row.department
      },
      lineOccupancy: row.line_group_id
        ? {
            position: row.position,
            lineGroup: {
              id: row.line_group_id,
              code: row.line_group_code,
              name: row.line_group_name
            },
            parkingPlace: {
              id: row.parking_place_id,
              code: row.parking_place_code,
              title: row.parking_place_title
            }
          }
        : null
    }));
  }

  async function listPlansForUser(userId) {
    return repository.listPlansForUser(dbRepository, userId);
  }

  // The whole upsert is one transaction: the employee lookup, the multi-line eligibility
  // check and the lock check all have to see the same snapshot the insert writes into.
  async function upsertPlan({ userId, planDate, departureTime, actorService }) {
    return withTransaction(pool, async (repo) => {
      const user = await employeesRepository.findEmployeeById(repo, userId);

      if (!user) {
        throw abortWith(404, 'Employee not found');
      }

      const multiLinePlace = await placesRepository.findMultiLinePlaceForUser(repo, { userId, planDate });

      if (!multiLinePlace) {
        throw abortWith(
          409,
          'Departure time can be set only for users with a multi-line place or multi-line reservation on this date'
        );
      }

      // The wall-clock 07:00 check in the controller only covers "today in APP_TIMEZONE".
      // lock-departure-plans persists the same decision, so a plan stays locked
      // across a day rollover and the rule can be replayed on any date.
      const lockedPlan = await repository.findLockedPlan(repo, { userId, planDate });

      if (lockedPlan) {
        throw abortWith(409, 'Departure plan editing is locked for this date', {
          lockedAt: lockedPlan.locked_at,
          timezone: appTimezone
        });
      }

      const plan = await repository.upsertPlan(repo, {
        userId,
        planDate,
        departureTime,
        isEarly: isEarlyDeparture(departureTime)
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'departure_plan',
        entityId: plan.id,
        action: 'departure_plan_upserted',
        actorUserId: userId,
        actorService,
        metadata: {
          userId,
          userDisplayName: user.display_name,
          planDate,
          departureTime,
          isEarly: plan.is_early
        }
      });

      return { plan, user };
    });
  }

  return {
    getPlansForDate,
    listPlansForUser,
    upsertPlan
  };
}

module.exports = {
  createDeparturePlansService
};
