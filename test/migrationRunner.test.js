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
  after(async () => {
    await pool.end();
  });

  it('registers every migration with a valid version, name, and up function', () => {
    assert.ok(migrations.length > 0);
    migrations.forEach((migration, index) => {
      assert.equal(migration.version, index + 1);
      assert.equal(typeof migration.name, 'string');
      assert.ok(migration.name.trim());
      assert.equal(typeof migration.up, 'function');
    });
    assert.equal(
      migrations[65].name,
      'purge legacy anritvox artifacts and seed luxury geo catalog'
    );
  });

  it('expands the customer reset OTP column to hold its hash', async () => {
    const migration = migrations.find(candidate => candidate.name === 'expand customer password reset OTP hashes');
    const originalQuery = pool.query;
    const statements = [];
    pool.query = async sql => {
      statements.push(sql);
      return [{}, []];
    };

    try {
      await migration.up();
    } finally {
      pool.query = originalQuery;
    }

    assert.deepEqual(statements, [
      'ALTER TABLE users MODIFY COLUMN reset_otp VARCHAR(64) DEFAULT NULL',
    ]);
  });

  it('adds opt-in-only personalization fields and a consent audit table', async () => {
    const migration = migrations.find(candidate => candidate.name === 'record optional ad-personalization consent');
    const originalQuery = pool.query;
    const statements = [];
    pool.query = async sql => {
      statements.push(sql);
      return sql.startsWith('SHOW COLUMNS') ? [[], []] : [{}, []];
    };

    try {
      await migration.up();
    } finally {
      pool.query = originalQuery;
    }

    const alters = statements.filter(sql => sql.startsWith('ALTER TABLE'));
    assert.equal(alters.length, 5);
    assert.ok(alters.every(sql => /ad_personalization/.test(sql)));
    assert.match(statements.at(-1), /CREATE TABLE IF NOT EXISTS privacy_consent_events/);
    assert.match(statements.at(-1), /granted TINYINT\(1\) NOT NULL/);
    assert.match(statements.at(-1), /source ENUM\('registration','profile'\)/);
  });

  it('resets legacy personalization choices and clears historical product views', async () => {
    const migration = migrations.find(candidate => candidate.name === 'require updated consent for product recommendations');
    const originalQuery = pool.query;
    const statements = [];
    pool.query = async sql => {
      statements.push(sql);
      return [{ affectedRows: 1 }, []];
    };

    try {
      await migration.up();
    } finally {
      pool.query = originalQuery;
    }

    assert.match(statements[0], /ENUM\('registration','profile','system'\)/);
    assert.match(statements[1], /INSERT INTO privacy_consent_events/);
    assert.match(statements[1], /'personalized_recommendations', 0/);
    assert.ok(statements.some(sql => /UPDATE users[\s\S]*SET ad_personalization_opt_in = 0/.test(sql)));
    assert.ok(statements.some(sql => /UPDATE pending_registrations[\s\S]*SET ad_personalization_opt_in = 0/.test(sql)));
    assert.match(statements.at(-1), /DELETE FROM user_product_views/);
  });

  it('seeds default post-order spin rewards without replacing existing admin settings', async () => {
    const migration = migrations.find(candidate => candidate.name === 'seed default post-order spin rewards');
    const originalQuery = pool.query;
    let statement;
    let values;
    pool.query = async (sql, params = []) => {
      if (sql.startsWith('SELECT value FROM settings')) return [[], []];
      statement = sql;
      values = params;
      return [{ affectedRows: 1 }, []];
    };

    try {
      await migration.up();
    } finally {
      pool.query = originalQuery;
    }

    assert.match(statement, /INSERT INTO settings/);
    assert.match(statement, /ON DUPLICATE KEY UPDATE value = IF\(value IS NULL OR TRIM\(value\) = '', VALUES\(value\), value\)/);
    const rewards = JSON.parse(values[0]);
    assert.equal(rewards.length, 6);
    assert.equal(rewards.reduce((total, reward) => total + reward.chance, 0), 100);

    const validRewards = JSON.stringify(rewards);
    const statements = [];
    pool.query = async (sql, params = []) => {
      statements.push(sql);
      if (sql.startsWith('SELECT value FROM settings')) return [[{ value: validRewards }], []];
      return [{ affectedRows: 1 }, []];
    };
    try {
      await migration.up();
    } finally {
      pool.query = originalQuery;
    }
    assert.equal(statements.length, 1, 'valid admin rewards should remain unchanged');

    const invalidStatements = [];
    pool.query = async (sql, params = []) => {
      invalidStatements.push(sql);
      if (sql.startsWith('SELECT value FROM settings')) {
        return [[{ value: JSON.stringify(rewards.slice(0, 5)) }], []];
      }
      values = params;
      return [{ affectedRows: 1 }, []];
    };
    try {
      await migration.up();
    } finally {
      pool.query = originalQuery;
    }
    assert.equal(invalidStatements.length, 2, 'invalid saved rewards should be repaired');
    assert.equal(JSON.parse(values[0]).length, 6);
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
