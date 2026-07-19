'use strict';

const { employeePoolSize, findDriftedDeparturePlans, summarizeEmployeePool } = require('../../../../../packages/domain');
const { withTransaction } = require('../../repositories/db');
const { mapJobRun } = require('../../serializers/job-runs');
const { calculateAvailabilitySnapshot, countAvailableReleasedPlaces } = require('../../services/availability');
const auditRepository = require('../audit/repository');
const departurePlansRepository = require('../departure-plans/repository');
const placeReleasesRepository = require('../place-releases/repository');
const queueRepository = require('../queue/repository');
const repository = require('./repository');

function createJobsService({ pool, dbRepository, appTimezone, guestReserveMinimum, services }) {
  // Bookkeeping order is part of the contract the integration tests assert: the `job_runs`
  // row is written *before* the work, the terminal state and the audit row *after* it, and
  // a failure carries the finished run back to the controller on `error.jobRun`.
  async function withJobRun(jobName, targetDate, runner) {
    const started = await repository.startJobRun(dbRepository, { jobName, targetDate });

    try {
      const payload = await runner();
      const finished = await repository.markJobRunSucceeded(dbRepository, {
        jobRunId: started.id,
        summary: payload
      });

      await auditRepository.insertAuditLog(dbRepository, {
        entityType: 'system',
        action: `job_${jobName}_success`,
        actorService: 'admin-web',
        metadata: {
          jobRunId: started.id,
          jobName,
          targetDate,
          summary: payload
        }
      });

      return {
        ...payload,
        jobRun: mapJobRun(finished)
      };
    } catch (error) {
      const failed = await repository.markJobRunFailed(dbRepository, {
        jobRunId: started.id,
        error: error.message
      });

      await auditRepository.insertAuditLog(dbRepository, {
        entityType: 'system',
        action: `job_${jobName}_failed`,
        actorService: 'admin-web',
        metadata: {
          jobRunId: started.id,
          jobName,
          targetDate,
          error: error.message
        }
      });

      error.jobRun = mapJobRun(failed);
      throw error;
    }
  }

  async function runProcessQueue(queueDate) {
    return withJobRun('process_queue', queueDate, () => services.queue.processQueueForDate(queueDate));
  }

  async function runFreezeNextDay(targetDate) {
    return withJobRun('freeze_next_day', targetDate, async () =>
      withTransaction(pool, async (repo) => {
        await placeReleasesRepository.lockFreezeForDate(repo, targetDate);

        const snapshot = await calculateAvailabilitySnapshot(repo, targetDate, { appTimezone, guestReserveMinimum });
        const frozen = await placeReleasesRepository.freezeReleasesForDate(repo, targetDate);
        const releases = await placeReleasesRepository.listReleasesWithFrozenState(repo, targetDate);
        const frozenCount = frozen.length;

        // Only a run that changed something leaves an audit trail; re-running
        // the job must not grow the journal with identical rows.
        if (frozenCount > 0) {
          await auditRepository.insertAuditLog(repo, {
            entityType: 'system',
            action: 'availability_frozen',
            actorService: 'admin-web',
            metadata: {
              targetDate,
              timezone: appTimezone,
              releaseCount: releases.length,
              frozenCount,
              availability: snapshot
            }
          });
        }

        return {
          date: targetDate,
          timezone: appTimezone,
          releaseCount: releases.length,
          frozenCount,
          alreadyFrozen: frozenCount === 0,
          availability: snapshot,
          frozenReleases: releases.map((release) => ({
            id: release.id,
            parkingPlaceId: release.parking_place_id,
            parkingPlaceCode: release.parking_place_code,
            placeType: release.place_type,
            ownerUserId: release.owner_user_id
          }))
        };
      })
    );
  }

  async function runLockDeparturePlans(targetDate) {
    return withJobRun('lock_departure_plans', targetDate, async () => {
      // `locked_at is null` is the idempotency guard: the second run of the day
      // locks nothing and writes no audit row.
      const lockedResult = await departurePlansRepository.lockPlansForDate(dbRepository, targetDate);
      const summary = await departurePlansRepository.summarizePlansForDate(dbRepository, targetDate);
      const lockedCount = lockedResult.length;

      if (lockedCount > 0) {
        await auditRepository.insertAuditLog(dbRepository, {
          entityType: 'system',
          action: 'departure_plan_editing_locked',
          actorService: 'admin-web',
          metadata: {
            targetDate,
            timezone: appTimezone,
            plansCount: summary?.plans_count || 0,
            earlyPlansCount: summary?.early_plans_count || 0,
            lockedCount
          }
        });
      }

      return {
        date: targetDate,
        timezone: appTimezone,
        plansCount: summary?.plans_count || 0,
        earlyPlansCount: summary?.early_plans_count || 0,
        lockedCount,
        alreadyLocked: lockedCount === 0
      };
    });
  }

  /**
   * Settle how much of the next day's released pool employees may take.
   *
   * The pool itself is opened by freeze-next-day (which fixes the set of released
   * places) and consumed by process-queue at day start. This job is the step
   * between them: it computes, records and announces the employee capacity —
   * everything released minus the guest reserve — so the operator can see at
   * 19:00 how many of the queued employees will actually get a place, instead of
   * finding out the next morning.
   *
   * It writes no reservations, so it is naturally replay-safe; the audit row is
   * written once per date, which is what makes a second run a true no-op.
   */
  async function runUnlockEmployeePool(targetDate) {
    return withJobRun('unlock_employee_pool', targetDate, async () =>
      withTransaction(pool, async (repo) => {
        await placeReleasesRepository.lockEmployeePoolForDate(repo, targetDate);

        const availableReleasedPlacesCount = await countAvailableReleasedPlaces(repo, targetDate);
        const poolSize = employeePoolSize(availableReleasedPlacesCount, guestReserveMinimum);

        const queueSummary = await queueRepository.summarizeWaitingQueue(repo, {
          queueDate: targetDate,
          employeePoolSize: poolSize
        });

        const { waitingCount, servableCount, unservableCount } = summarizeEmployeePool({
          employeePoolSize: poolSize,
          waitingCount: queueSummary?.waiting_count,
          servableCount: queueSummary?.servable_count
        });

        const alreadyUnlocked = await auditRepository.findEmployeePoolUnlockedLog(repo, targetDate);

        if (!alreadyUnlocked) {
          await auditRepository.insertAuditLog(repo, {
            entityType: 'system',
            action: 'employee_pool_unlocked',
            actorService: 'admin-web',
            metadata: {
              targetDate,
              timezone: appTimezone,
              guestReserveMinimum,
              availableReleasedPlacesCount,
              employeePoolSize: poolSize,
              waitingCount,
              servableCount
            }
          });
        }

        return {
          date: targetDate,
          timezone: appTimezone,
          guestReserveMinimum,
          availableReleasedPlacesCount,
          employeePoolSize: poolSize,
          waitingCount,
          servableCount,
          unservableCount,
          alreadyUnlocked: Boolean(alreadyUnlocked)
        };
      })
    );
  }

  /**
   * Recompute the early-departure conflicts for a date.
   *
   * Two things drift: `departure_plans.is_early` is stamped from the cut-off rule
   * at write time and never revisited, and the conflict set depends on line
   * occupancy that moves during the day. Both are pure recomputations from
   * current data, so running this twice in a row is by construction a no-op — the
   * second run reports `changed: false` and writes no audit row.
   */
  async function runRebuildConflicts(targetDate) {
    return withJobRun('rebuild_conflicts', targetDate, async () => {
      const plans = await departurePlansRepository.listPlanEarlyFlagsForDate(dbRepository, targetDate);

      const drifted = findDriftedDeparturePlans(plans);

      for (const plan of drifted) {
        await departurePlansRepository.updatePlanEarlyFlag(dbRepository, {
          planId: plan.id,
          isEarly: plan.isEarly
        });
      }

      const conflicts = await services.conflicts.getConflictsForDate(targetDate);
      const changed = drifted.length > 0;

      if (changed) {
        await auditRepository.insertAuditLog(dbRepository, {
          entityType: 'system',
          action: 'conflicts_rebuilt',
          actorService: 'admin-web',
          metadata: {
            targetDate,
            timezone: appTimezone,
            plansCount: plans.length,
            recalculatedCount: drifted.length,
            conflictCount: conflicts.length
          }
        });
      }

      return {
        date: targetDate,
        timezone: appTimezone,
        plansCount: plans.length,
        recalculatedCount: drifted.length,
        conflictCount: conflicts.length,
        conflicts,
        changed
      };
    });
  }

  async function listJobRuns({ jobName, targetDate, limit }) {
    const runs = await repository.listJobRuns(dbRepository, {
      jobName,
      targetDate,
      limit
    });
    const latestSuccessfulRuns = await repository.listLatestSuccessfulRuns(dbRepository, jobName);

    return { runs, latestSuccessfulRuns };
  }

  return {
    listJobRuns,
    runFreezeNextDay,
    runLockDeparturePlans,
    runProcessQueue,
    runRebuildConflicts,
    runUnlockEmployeePool,
    withJobRun
  };
}

module.exports = {
  createJobsService
};
