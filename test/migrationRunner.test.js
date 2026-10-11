const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const { runMigrations } = require('../utils/migrationRunner');
const migrations = require('../migrations');
const pool = require('../config/db');

const createPool = () => {
  const applied = new Map();
  let lockAcquired = false;
  return {
    applied,
    async getConnection() {
      return {
        async query(sql) {
          if (sql.includes('GET_LOCK')) {
            lockAcquired = true;
            return [[{ lock_acquired: 1 }]];
          }
          if (sql.includes('RELEASE_LOCK')) {
            lockAcquired = false;
            return [[{ released: 1 }]];
          }
          throw new Error(`Unexpected connection query: ${sql}`);
        },
        release() {},
      };
    },
    async query(sql, params = []) {
      if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) return [{}, []];
      if (sql.includes('SELECT version, name FROM schema_migrations')) {
        return [[...applied].map(([version, name]) => ({ version, name })), []];
      }
      if (sql.includes('INSERT INTO schema_migrations')) {
        assert.equal(lockAcquired, true);
        applied.set(params[0], params[1]);
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
  };
};

const logger = { info() {}, error() {} };

describe('runMigrations', () => {
  it('registers every migration with a valid version, name, and up function', () => {
    assert.ok(migrations.length > 0);
    migrations.forEach((migration, index) => {
      assert.equal(migration.version, index + 1);
      assert.equal(typeof migration.name, 'string');
      assert.ok(migration.name.trim());
      assert.equal(typeof migration.up, 'function');
    });
  });

  it('records each successful migration and skips it on later runs', async () => {
    const pool = createPool();
    let executionCount = 0;
    const migrations = [
      { version: 1, name: 'first schema change', up: async () => { executionCount += 1; } },
      { version: 2, name: 'second schema change', up: async () => { executionCount += 1; } },
    ];

    await runMigrations(pool, migrations, { logger });
    await runMigrations(pool, migrations, { logger });

    assert.equal(executionCount, 2);
    assert.deepEqual([...pool.applied], [[1, 'first schema change'], [2, 'second schema change']]);
  });

  it('does not record failures and can retry the failed migration', async () => {
    const pool = createPool();
    let shouldFail = true;
    const migration = {
      version: 1,
      name: 'retryable schema change',
      up: async () => {
        if (shouldFail) throw new Error('database unavailable');
      },
    };

    await assert.rejects(runMigrations(pool, [migration], { logger }), error => {
      assert.equal(error.migration.version, 1);
      return error.message === 'database unavailable';
    });
    assert.equal(pool.applied.size, 0);

    shouldFail = false;
    await runMigrations(pool, [migration], { logger });
    assert.deepEqual([...pool.applied], [[1, 'retryable schema change']]);
  });

  it('rejects migrations whose versions are duplicated or out of order', async () => {
    const pool = createPool();
    const noop = async () => {};
    await assert.rejects(
      runMigrations(pool, [
        { version: 2, name: 'later', up: noop },
        { version: 1, name: 'earlier', up: noop },
      ], { logger }),
      /versions must/
    );
  });
});


after(async () => {
    await pool.end();
});
