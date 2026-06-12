'use strict';

function createDbRepository(pool) {
  async function queryOne(text, params = []) {
    if (!pool) {
      throw new Error('DATABASE_URL is not configured');
    }

    const result = await pool.query(text, params);
    return result.rows[0] || null;
  }

  async function queryMany(text, params = []) {
    if (!pool) {
      throw new Error('DATABASE_URL is not configured');
    }

    const result = await pool.query(text, params);
    return result.rows;
  }

  return {
    queryMany,
    queryOne
  };
}

module.exports = {
  createDbRepository
};
