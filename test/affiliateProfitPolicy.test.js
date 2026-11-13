const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { calculateAffiliateProfit } = require('../services/affiliateProfitPolicy');

const config = {
  commissionSharePercent: 25,
  fulfillmentCost: 220,
  rtoReserve: 100,
  onlinePaymentFeePercent: 2,
  minimumRetainedMarginPercent: 12,
};

describe('affiliate profit policy', () => {
  it('calculates contribution and commission from GST-exclusive revenue', () => {
    const result = calculateAffiliateProfit({
      ...config,
      items: [{ unitPrice: 799, quantity: 1, gstRate: 18, unitCost: 62 }],
      merchandiseSubtotal: 799,
      totalMerchandiseDiscount: 119.85,
      paymentTotal: 679.15,
      paymentMode: 'online',
    });

    assert.equal(result.revenueExcludingTax, 575.55);
    assert.equal(result.contributionProfit, 179.97);
    assert.equal(result.commission, 44.99);
    assert.equal(result.retainedMarginPercent, 23.45);
    assert.equal(result.eligible, true);
  });

  it('caps commission to keep the retained margin at the hard floor', () => {
    const result = calculateAffiliateProfit({
      ...config,
      items: [{ unitPrice: 704.71, quantity: 1, gstRate: 18, unitCost: 94.43 }],
      merchandiseSubtotal: 704.71,
      totalMerchandiseDiscount: 105.71,
      paymentTotal: 599,
      paymentMode: 'online',
    });

    assert.equal(result.retainedMarginPercent, 12);
    assert.ok(result.commission < result.contributionProfit * 0.25);
    assert.equal(result.eligible, true);
  });

  it('marks a promotion ineligible when the costs cannot meet the retained-margin floor', () => {
    const result = calculateAffiliateProfit({
      ...config,
      items: [{ unitPrice: 704.71, quantity: 1, gstRate: 18, unitCost: 120 }],
      merchandiseSubtotal: 704.71,
      totalMerchandiseDiscount: 105.71,
      paymentTotal: 599,
      paymentMode: 'online',
    });

    assert.equal(result.marginFloorMet, false);
    assert.equal(result.eligible, false);
    assert.equal(result.commission, 0);
  });
});
