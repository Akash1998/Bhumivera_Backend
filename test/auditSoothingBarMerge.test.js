const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMergePlan,
  getCatalogSnapshot,
  isProductReferenceColumn,
} = require('../scripts/auditSoothingBarMerge');

test('merge plan prefers the canonical SKU and identifies the legacy row', () => {
  const plan = buildMergePlan([
    { id: 17, sku: 'BV-LUX-ASOAP-05', quantity: 286 },
    { id: 22, sku: 'BV-PROD-22', quantity: 4 },
  ]);

  assert.equal(plan.action, 'merge_legacy_into_canonical');
  assert.equal(plan.canonicalProductId, 17);
  assert.equal(plan.legacyProductId, 22);
  assert.equal(plan.stockReviewRequired, true);
});

test('merge plan preserves the legacy product ID if the canonical row was deleted', () => {
  const plan = buildMergePlan([{ id: 22, sku: 'BV-PROD-22', quantity: 4 }]);

  assert.equal(plan.action, 'rename_legacy_product_to_canonical_sku');
  assert.equal(plan.canonicalProductId, null);
  assert.equal(plan.legacyProductId, 22);
  assert.equal(plan.stockReviewRequired, false);
});

test('merge plan reports when neither SKU exists without proposing a write', () => {
  const plan = buildMergePlan([]);

  assert.equal(plan.action, 'no_matching_products');
  assert.equal(plan.canonicalProductId, null);
  assert.equal(plan.legacyProductId, null);
});

test('reference discovery includes direct and JSON product ID columns', () => {
  assert.equal(isProductReferenceColumn('product_id'), true);
  assert.equal(isProductReferenceColumn('gift_product_id'), true);
  assert.equal(isProductReferenceColumn('applicable_product_ids'), true);
  assert.equal(isProductReferenceColumn('description'), false);
});

test('repository snapshot contains canonical soothing bar SEO content', () => {
  const snapshot = getCatalogSnapshot();

  assert.equal(snapshot.sku, 'BV-LUX-ASOAP-05');
  assert.match(snapshot.seoTitle, /Soothing Bar/);
  assert.match(snapshot.metaDescription, /Aloe Vera, Neem, and Sacred Tulsi/);
});
