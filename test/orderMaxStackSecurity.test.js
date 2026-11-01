const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateShippingCost } = require('../services/shippingPolicy');
const { calculateTieredReferralWalletRedemption } = require('../services/orderPaymentPolicy');
const { calculateLoyaltyRedemption, calculateTierDiscount } = require('../services/loyaltyPolicy');

test('failsafe & unhackable stacking security policy', async (t) => {
  const referralTiers = [
    { min_order_amount: 799, referral_amount: 100 },
    { min_order_amount: 1499, referral_amount: 250 },
  ];

  await t.test('free shipping unlocks strictly at >= ₹599', () => {
    // Below ₹599: shipping is charged
    assert.equal(
      calculateShippingCost({
        deliveryType: 'standard',
        cartSubtotal: 598.99,
        standardCharge: 50,
        freeShippingThreshold: 599,
        freeShipping: false,
      }),
      50,
      'Orders below ₹599 must pay shipping'
    );

    // At ₹599: shipping is free
    assert.equal(
      calculateShippingCost({
        deliveryType: 'standard',
        cartSubtotal: 599.00,
        standardCharge: 50,
        freeShippingThreshold: 599,
        freeShipping: false,
      }),
      0,
      'Orders at ₹599 must get free shipping'
    );
  });

  await t.test('gift card / referral wallet is blocked below ₹799 and strictly capped at ₹100 for ₹999', () => {
    const fullGiftBalance = 250.00;

    // Order of ₹798: Zero discount allowed
    assert.equal(
      calculateTieredReferralWalletRedemption(fullGiftBalance, 798.99, referralTiers, 798.99),
      0,
      'No gift card / referral deduction allowed below ₹799'
    );

    // Order of ₹999: Max ₹100 allowed (even with ₹250 or ₹500 balance)
    assert.equal(
      calculateTieredReferralWalletRedemption(fullGiftBalance, 999.00, referralTiers, 999.00),
      100,
      'Orders between ₹799 and ₹1498 are capped at exactly ₹100'
    );

    // Order of ₹2000: Full ₹250 allowed
    assert.equal(
      calculateTieredReferralWalletRedemption(fullGiftBalance, 2000.00, referralTiers, 2000.00),
      250,
      'Orders at or above ₹1499 can unlock full ₹250'
    );
  });

  await t.test('loyalty points redemption is strictly capped at 10% maximum', () => {
    const userPointsBalance = 10000; // Customer has 10,000 points (₹1,000 worth)
    const eligibleAmount = 775.13;

    const result = calculateLoyaltyRedemption({
      pointsBalance: userPointsBalance,
      eligibleSubtotal: eligibleAmount,
      redemptionPointsPerRupee: 10,
      maxRedemptionPercent: 10, // 10% cap
      minimumRedemptionPoints: 100,
      enabled: true,
    });

    // 10% of 775.13 = max ₹77.51, capped to nearest 10-point increment (₹77.50)
    assert.ok(
      result.discount <= 77.51,
      `Loyalty discount (${result.discount}) must not exceed 10% cap (77.51)`
    );
    assert.equal(result.discount, 77.50);
    assert.equal(result.points, 775);
  });

  await t.test('end-to-end ₹999 purchase calculation matches profit protection guarantee', () => {
    const subtotal = 999.00;

    // 1. Gift card / referral deduction (capped at ₹100)
    const walletDeduction = calculateTieredReferralWalletRedemption(250, subtotal, referralTiers, subtotal);
    assert.equal(walletDeduction, 100);

    // 2. 10% coupon on subtotal
    const couponDiscount = 99.90;

    // 3. Platinum tier discount (3% of subtotal, bounded by remaining balance)
    const tierDiscount = calculateTierDiscount(subtotal, walletDeduction + couponDiscount, 3, true);
    assert.equal(tierDiscount, 29.97);

    // Post-tier eligible balance for points
    const postTier = subtotal - walletDeduction - couponDiscount - tierDiscount; // 769.13

    // 4. Loyalty points capped at 10% of remaining 769.13
    const loyalty = calculateLoyaltyRedemption({
      pointsBalance: 5000,
      eligibleSubtotal: postTier,
      redemptionPointsPerRupee: 10,
      maxRedemptionPercent: 10,
      minimumRedemptionPoints: 100,
      enabled: true,
    });
    assert.equal(loyalty.discount, 76.90);
    assert.equal(loyalty.points, 769);

    // 5. Final payable
    const totalDeductions = walletDeduction + couponDiscount + tierDiscount + loyalty.discount;
    const finalPayable = subtotal - totalDeductions;

    assert.equal(Math.round(totalDeductions * 100) / 100, 306.77);
    assert.equal(Math.round(finalPayable * 100) / 100, 692.23);

    // Assert that the store retains >= 69% of gross merchandise value
    assert.ok(
      finalPayable >= 690,
      `Store must retain at least ₹690 on a ₹999 order (actual retained: ₹${finalPayable})`
    );
  });
});
