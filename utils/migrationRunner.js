const MIGRATION_LOCK_NAME = 'bhumivera-schema-migrations';
const MIGRATION_LOCK_TIMEOUT_SECONDS = 30;

const validateMigrations = migrations => {
  const versions = new Set();
  let previousVersion = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1 ||
        typeof migration.name !== 'string' || !migration.name.trim() ||
        typeof migration.up !== 'function') {
      throw new Error('Each migration requires a positive integer version, name, and up function.');
    }
    if (versions.has(migration.version) || migration.version <= previousVersion) {
      throw new Error('Migrations must have unique versions in ascending order.');
    }
    versions.add(migration.version);
    if (migration.version !== previousVersion + 1) {
      throw new Error('Migration versions must start at 1 and be contiguous.');
    }
    previousVersion = migration.version;
  }
};

async function runMigrations(pool, migrations, { logger = console } = {}) {
  validateMigrations(migrations);
  let lockConnection;
  let lockAcquired = false;
  let migrationPhase = 'acquire_connection';
  try {
    lockConnection = await pool.getConnection();
    migrationPhase = 'acquire_lock';
    const [lockRows] = await lockConnection.query(
      'SELECT GET_LOCK(?, ?) AS lock_acquired',
      [MIGRATION_LOCK_NAME, MIGRATION_LOCK_TIMEOUT_SECONDS]
    );
    lockAcquired = Number(lockRows?.[0]?.lock_acquired) === 1;
    if (!lockAcquired) {
      const error = new Error(`Could not acquire the schema migration lock within ${MIGRATION_LOCK_TIMEOUT_SECONDS} seconds.`);
      error.code = 'MIGRATION_LOCK_FAILED';
      throw error;
    }

    migrationPhase = 'prepare_history';
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT NOT NULL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    migrationPhase = 'read_history';
    const [appliedRows] = await pool.query(
      'SELECT version, name FROM schema_migrations ORDER BY version'
    );
    const applied = new Map(appliedRows.map(row => [Number(row.version), row.name]));
    const pendingVersions = new Set(migrations.map(migration => migration.version));
    let expectedAppliedVersion = 1;

    for (const [version, name] of applied) {
      if (version !== expectedAppliedVersion) {
        throw new Error(`Database migration history is not contiguous at version ${expectedAppliedVersion}.`);
      }
      if (!pendingVersions.has(version)) {
        throw new Error(`Database has migration ${version} (${name}) which this application does not know about.`);
      }
      const migration = migrations.find(candidate => candidate.version === version);
      if (migration.name !== name) {
        throw new Error(`Migration ${version} name mismatch: database has "${name}", application has "${migration.name}".`);
      }
      expectedAppliedVersion += 1;
    }

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      logger.info(`[MIGRATION] Starting ${migration.version}: ${migration.name}`);
      migrationPhase = 'apply_migration';
      try {
        await migration.up();
        migrationPhase = 'record_migration';
        await pool.query(
          'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
          [migration.version, migration.name]
        );
      } catch (error) {
        logger.error(`[MIGRATION] Failed ${migration.version}: ${migration.name}`, error);
        const migrationError = error instanceof Error ? error : new Error(String(error));
        migrationError.migration = { version: migration.version, name: migration.name };
        throw migrationError;
      }
      logger.info(`[MIGRATION] Applied ${migration.version}: ${migration.name}`);
      migrationPhase = 'read_history';
    }
    return migrations.map(({ version, name }) => ({ version, name }));
  } catch (error) {
    const migrationError = error instanceof Error ? error : new Error(String(error));
    migrationError.migrationPhase = migrationPhase;
    throw migrationError;
  } finally {
    if (lockAcquired && lockConnection) {
      try {
        await lockConnection.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK_NAME]);
      } catch (error) {
        logger.error('[MIGRATION] Failed to release schema migration lock.', error);
      }
    }
    lockConnection?.release();
  }
}

module.exports = { runMigrations };
