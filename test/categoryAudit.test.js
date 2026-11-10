const assert = require('node:assert/strict');
const { beforeEach, describe, it } = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const categoryModelPath = path.resolve(__dirname, '../models/categoryModel.js');
const originalLoad = Module._load;
const queries = [];
let failAuditInsert = false;
let lockedCategory = {
  id: 12,
  name: 'Before',
  description: 'Before description',
  image_url: null,
  is_active: 1,
};

const connection = {
  async beginTransaction() {
    queries.push({ sql: 'BEGIN' });
  },
  async commit() {
    queries.push({ sql: 'COMMIT' });
  },
  async rollback() {
    queries.push({ sql: 'ROLLBACK' });
  },
  release() {
    queries.push({ sql: 'RELEASE' });
  },
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes('SELECT id, name, description, image_url, is_active FROM categories')) {
      return [[lockedCategory]];
    }
    if (sql.includes('INSERT INTO categories')) return [{ insertId: 21 }];
    if (sql.includes('INSERT INTO category_audit_log')) {
      if (failAuditInsert) throw new Error('audit unavailable');
      return [{ affectedRows: 1 }];
    }
    return [{ affectedRows: 1 }];
  },
};

const fakePool = {
  async getConnection() {
    return connection;
  },
  async query(sql, params = []) {
    queries.push({ sql, params });
    return [[{ id: 2, action: 'created' }]];
  },
};

Module._load = function (request, parent, isMain) {
  if (parent?.filename === categoryModelPath && request === '../config/db') return fakePool;
  return originalLoad.call(this, request, parent, isMain);
};
const categoryModel = require(categoryModelPath);
Module._load = originalLoad;

const actor = { id: 7, email: 'admin@example.com' };

describe('category audit history', () => {
  beforeEach(() => {
    queries.length = 0;
    failAuditInsert = false;
    lockedCategory = {
      id: 12,
      name: 'Before',
      description: 'Before description',
      image_url: null,
      is_active: 1,
    };
  });

  it('commits category creation and its audit snapshot in one transaction', async () => {
    const id = await categoryModel.createCategory({ name: '  New category  ' }, actor);
    assert.equal(id, 21);
    const audit = queries.find(entry => entry.sql.includes('INSERT INTO category_audit_log'));
    assert.deepEqual(audit.params, [
      7,
      'admin@example.com',
      'created',
      21,
      null,
      JSON.stringify({
        id: 21,
        name: 'New category',
        description: null,
        image_url: null,
        is_active: 1,
      }),
    ]);
    assert.ok(queries.some(entry => entry.sql === 'COMMIT'));
    assert.ok(!queries.some(entry => entry.sql === 'ROLLBACK'));
  });

  it('records before and after snapshots for updates', async () => {
    await categoryModel.updateCategory(12, {
      name: 'After',
      description: 'After description',
      is_active: 0,
    }, actor);
    const audit = queries.find(entry => entry.sql.includes('INSERT INTO category_audit_log'));
    assert.equal(audit.params[2], 'updated');
    assert.equal(JSON.parse(audit.params[4]).name, 'Before');
    assert.equal(JSON.parse(audit.params[5]).name, 'After');
    assert.ok(queries.some(entry => entry.sql.includes('FOR UPDATE')));
  });

  it('records the deleted category snapshot', async () => {
    await categoryModel.deleteCategory(12, actor);
    const audit = queries.find(entry => entry.sql.includes('INSERT INTO category_audit_log'));
    assert.equal(audit.params[2], 'deleted');
    assert.equal(JSON.parse(audit.params[4]).name, 'Before');
    assert.equal(audit.params[5], null);
  });

  it('rolls the category mutation back when the audit entry cannot be stored', async () => {
    failAuditInsert = true;
    await assert.rejects(
      categoryModel.createCategory({ name: 'New category' }, actor),
      /audit unavailable/
    );
    assert.ok(queries.some(entry => entry.sql === 'ROLLBACK'));
    assert.ok(!queries.some(entry => entry.sql === 'COMMIT'));
  });

  it('rejects invalid categories before opening a database transaction', async () => {
    await assert.rejects(
      categoryModel.createCategory({ name: ' ' }, actor),
      error => error.code === 'INVALID_CATEGORY'
    );
    assert.equal(queries.length, 0);
  });
});
