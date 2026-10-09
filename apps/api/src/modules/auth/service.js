'use strict';

const { hashPassword } = require('../../../../../packages/shared/passwords');
const { withTransaction } = require('../../repositories/db');
const { abortWith } = require('../../support/transaction');
const auditRepository = require('../audit/repository');
const repository = require('./repository');

const MIN_PASSWORD_LENGTH = 10;

// One message for every state in which activation is refused — a second attempt, a login
// that does not exist, a database that already has more than the bootstrap user. Telling
// them apart would let the endpoint confirm which logins exist.
const ACTIVATION_REFUSED = 'Activation is not available';

function createAuthService({ pool }) {
  // First-run activation: the bootstrap `sysadmin` seeded by 001_bootstrap_system_admin.sql
  // has a placeholder hash, and this is how it gets a real one. Allowed only while the
  // database holds exactly one auth user and it is still `invited`; after that, passwords are
  // set by a system_admin. The rule is enforced here, not in the UI.
  async function activate({ login, password }) {
    // Hashed before the transaction opens: scrypt is the slow part, and the rows stay locked
    // only for the check and the write. It also means a refused attempt costs the same as an
    // accepted one.
    const passwordHash = await hashPassword(password);

    return withTransaction(pool, async (repo) => {
      const users = await repository.lockAllAuthUsers(repo);
      const [user] = users;

      if (users.length !== 1 || user.status !== 'invited' || user.login.toLowerCase() !== login.toLowerCase()) {
        throw abortWith(409, ACTIVATION_REFUSED);
      }

      const activated = await repository.activateAuthUser(repo, { id: user.id, passwordHash });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'auth_user',
        entityId: activated.id,
        action: 'auth_user_activated',
        actorAuthUserId: activated.id,
        actorService: 'admin-ui',
        metadata: { login: activated.login }
      });

      return activated;
    });
  }

  return {
    activate
  };
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  createAuthService
};
