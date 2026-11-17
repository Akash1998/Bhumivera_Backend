const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { describe, it } = require('node:test');

const modelPath = path.resolve(__dirname, '../models/affiliatePartnerModel.js');
const originalLoad = Module._load;
let insertedPartner;
let insertParams;
let dashboardPartner = null;
let dashboardSummary = null;
let dashboardSummaryQuery = '';
let dashboardCommissionsQuery = '';
let dashboardCommissionTotal = 0;
let dashboardCommissionsParams = [];
let storedPartner = {
  id: 17,
  status: 'approved',
  discount_percent: 13,
  commission_share_percent: 20,
  referral_code: 'BVCREATOR17',
  admin_notes: 'Existing note',
  reviewed_by: 3,
};
let partnerUpdateParams;

const fakePool = {
  async getConnection() {
    return {
      async beginTransaction() {},
      async query(sql, params = []) {
        if (sql.includes('SELECT * FROM affiliate_partners WHERE id = ? FOR UPDATE')) {
          return [[{ ...storedPartner }], []];
        }
        if (sql.includes('UPDATE affiliate_partners')) {
          partnerUpdateParams = params;
          storedPartner = {
            ...storedPartner,
            status: params[0],
            discount_percent: params[1],
            commission_share_percent: params[2],
            referral_code: params[3],
            admin_notes: params[4],
            reviewed_by: params[5] ?? storedPartner.reviewed_by,
          };
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected SQL in affiliate partner model test connection: ${sql}`);
      },
      async commit() {},
      async rollback() {},
      release() {},
    };
  },
  async query(sql, params = []) {
    if (sql === 'SELECT * FROM affiliate_partners WHERE id = ?') {
      return [[{ ...storedPartner }], []];
    }
    if (sql.includes('SELECT * FROM affiliate_partners WHERE user_id = ? LIMIT 1')) {
      return [dashboardPartner ? [dashboardPartner] : [], []];
    }
    if (sql.includes('SELECT key_name, value FROM settings')) {
      return [[], []];
    }
    if (sql.includes('SELECT * FROM affiliate_campaign_briefs')) {
      return [[], []];
    }
    if (sql.includes('SELECT COUNT(c.id) AS attributed_orders')) {
      dashboardSummaryQuery = sql;
      return [[dashboardSummary], []];
    }
    if (sql.includes('SELECT COUNT(*) AS total FROM affiliate_commissions WHERE partner_id = ?')) {
      return [[{ total: dashboardCommissionTotal }], []];
    }
    if (sql.includes('SELECT c.id, c.order_id, c.order_subtotal')) {
      dashboardCommissionsQuery = sql;
      dashboardCommissionsParams = params;
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
        partnership_intent: params[8],
        referral_code: params[9],
        discount_percent: params[10],
        commission_share_percent: params[11],
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
const {
  applyForPartner,
  getPartnerDashboard,
  updatePartner,
  bulkUpdatePartners,
  getPublicPromotionsShowcase,
} = require('../models/affiliatePartnerModel');
Module._load = originalLoad;

describe('affiliate partner applications', () => {
  it('updates profile rates and notes while preserving status and unrelated values', async () => {
    storedPartner = {
      id: 17,
      status: 'approved',
      discount_percent: 13,
      commission_share_percent: 20,
      referral_code: 'BVCREATOR17',
      admin_notes: 'Existing note',
      reviewed_by: 3,
    };
    partnerUpdateParams = null;

    const updated = await updatePartner(17, {
      commissionSharePercent: 27.5,
      adminNotes: 'New partnership note',
      adminId: 7,
    });

    assert.equal(updated.status, 'approved');
    assert.equal(updated.discount_percent, 13);
    assert.equal(updated.commission_share_percent, 27.5);
    assert.equal(updated.admin_notes, 'New partnership note');
    assert.equal(updated.referral_code, 'BVCREATOR17');
    assert.equal(updated.reviewed_by, 3);
    assert.deepEqual(partnerUpdateParams, [
      'approved',
      13,
      27.5,
      'BVCREATOR17',
      'New partnership note',
      null,
      'approved',
      17,
    ]);
  });

  it('creates a unique reserved code while leaving a new application pending', async () => {
    const result = await applyForPartner({
      userId: 42,
      socialPlatform: 'Instagram',
      socialHandle: '@creator',
      profileUrl: 'https://instagram.com/creator',
      followerCount: 1000,
      partnershipIntent: 'I want to create honest, useful skincare education with my community over time.',
    });

    assert.equal(result.alreadyApplied, false);
    assert.equal(result.partner.status, 'pending');
    assert.match(result.partner.referral_code, /^BV[A-F0-9]{10}$/);
    assert.equal(insertParams[8], result.partner.partnership_intent);
    assert.equal(insertParams[9], result.partner.referral_code);
    assert.equal(result.partner.discount_percent, 10);
    assert.equal(result.partner.commission_share_percent, 20);
  });

  it("reports collected impact contributions from the partner's attributed orders", async () => {
    dashboardPartner = { id: 17 };
    dashboardCommissionTotal = 65;
    dashboardSummary = {
      attributed_orders: 2,
      funded_impact_contributions: 1,
      impact_amount: '250.00',
    };

    const dashboard = await getPartnerDashboard(42, { commissionPage: 3 });

    assert.equal(Number(dashboard.summary.funded_impact_contributions), 1);
    assert.equal(Number(dashboard.summary.impact_amount), 250);
    assert.match(dashboardSummaryQuery, /LEFT JOIN impact_contributions ic/);
    assert.match(dashboardSummaryQuery, /ic\.status = 'collected'/);
    assert.match(dashboardSummaryQuery, /ic\.order_id = c\.order_id/);
    assert.match(dashboardCommissionsQuery, /c\.revenue_ex_tax/);
    assert.match(dashboardCommissionsQuery, /c\.product_cost/);
    assert.match(dashboardCommissionsQuery, /c\.contribution_profit/);
    assert.match(dashboardCommissionsQuery, /c\.retained_profit/);
    assert.deepEqual(dashboardCommissionsParams, [17, 20, 40]);
    assert.deepEqual(dashboard.commissionPagination, { page: 3, pageSize: 20, total: 65, pages: 4 });
  });

  it('supports bulk updating multiple promoter records and returns public showcase briefs', async () => {
    storedPartner = {
      id: 17,
      status: 'pending',
      discount_percent: 10,
      commission_share_percent: 20,
      referral_code: 'BVCREATOR17',
      admin_notes: null,
      reviewed_by: null,
    };

    const bulkResult = await bulkUpdatePartners({
      partnerIds: [17],
      status: 'approved',
      discountPercent: 15,
      commissionSharePercent: 25,
      adminId: 7,
    });
    assert.equal(bulkResult.updatedCount, 1);
    assert.equal(bulkResult.partners[0].status, 'approved');
    assert.equal(bulkResult.partners[0].discount_percent, 15);
    assert.equal(bulkResult.partners[0].commission_share_percent, 25);

    const showcase = await getPublicPromotionsShowcase();
    assert.equal(showcase.milestones.length, 3);
    assert.equal(showcase.campaignBriefs.length, 4);
    assert.equal(showcase.onboardingSteps.length, 3);
  });
});
