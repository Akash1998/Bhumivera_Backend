const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { describe, it } = require('node:test');

const modelPath = path.resolve(__dirname, '../models/affiliatePartnerModel.js');
const originalLoad = Module._load;
let insertedPartner;
let insertParams;

const fakePool = {
  async query(sql, params = []) {
    if (sql.includes('SELECT * FROM affiliate_partners WHERE user_id = ? LIMIT 1')) {
      return [[], []];
    }
    if (sql.includes('SELECT key_name, value FROM settings')) {
      return [[], []];
    }
    if (sql.includes('INSERT INTO affiliate_partners')) {
      insertParams = params;
      insertedPartner = {
        user_id: params[0],
        social_platform: params[1],
        social_handle: params[2],
        profile_url: params[3],
        follower_count: params[4],
        status: 'pending',
        referral_code: params[5],
        discount_percent: params[6],
        commission_share_percent: params[7],
      };
      return [{ insertId: 1 }, undefined];
    }
    if (sql.includes('SELECT * FROM affiliate_partners WHERE user_id = ?')) {
      return [[insertedPartner], []];
    }
    throw new Error(`Unexpected SQL in affiliate partner model test: ${sql}`);
  },
};

Module._load = function (request, parent, isMain) {
  if (parent?.filename === modelPath && request === '../config/db') return fakePool;
  return originalLoad.call(this, request, parent, isMain);
};
const { applyForPartner } = require('../models/affiliatePartnerModel');
Module._load = originalLoad;

describe('affiliate partner applications', () => {
  it('creates a unique reserved code while leaving a new application pending', async () => {
    const result = await applyForPartner({
      userId: 42,
      socialPlatform: 'Instagram',
      socialHandle: '@creator',
      profileUrl: 'https://instagram.com/creator',
      followerCount: 1000,
    });

    assert.equal(result.alreadyApplied, false);
    assert.equal(result.partner.status, 'pending');
    assert.match(result.partner.referral_code, /^BV[A-F0-9]{10}$/);
    assert.equal(insertParams[5], result.partner.referral_code);
    assert.equal(result.partner.discount_percent, 15);
    assert.equal(result.partner.commission_share_percent, 25);
  });
});
