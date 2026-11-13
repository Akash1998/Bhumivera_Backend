const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateShippingCost } = require('../services/shippingPolicy');
const { calculateTieredReferralWalletRedemption } = require('../services/orderPaymentPolicy');
const { calculateLoyaltyRedemption, calculateTierDiscount } = require('../services/loyaltyPolicy');

test('failsafe & unhackable stacking security policy', async (t) => {
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

  await t.test('welcome bonus remains separate from configured referral redemption tiers', () => {
    // Customer has ₹300 welcome bonus + ₹200 referral balance (total ₹500)
    const totalBalance = 500.00;
    const welcomeBonus = 300.00;

    // Order of ₹798: Zero discount
    assert.equal(
      calculateTieredReferralWalletRedemption(totalBalance, 798.99, [], 798.99, welcomeBonus),
      0,
      'No wallet deduction allowed below ₹799'
    );

    // Order of ₹799: Exactly ₹100 from welcome bonus
    assert.equal(
      calculateTieredReferralWalletRedemption(totalBalance, 799.00, [], 799.00, welcomeBonus),
      100,
      'At ₹799, exactly ₹100 allowed from welcome bonus'
    );

    // Order of ₹999: Exactly ₹100 from welcome bonus (referral balance not eligible below 1000)
    assert.equal(
      calculateTieredReferralWalletRedemption(totalBalance, 999.00, [], 999.00, welcomeBonus),
      100,
      'At ₹999, only ₹100 welcome bonus allowed'
    );

    // No configured referral tier means referral balance cannot be used.
    assert.equal(
      calculateTieredReferralWalletRedemption(200.00, 999.00, [], 999.00, 0),
      0,
      'Referral balance is unavailable without an eligible configured tier'
    );

    assert.equal(
      calculateTieredReferralWalletRedemption(200.00, 999.00, [{ min_order_amount: 799, referral_amount: 250 }], 999.00, 0),
      200,
      'An eligible configured referral tier caps use by the remaining balance'
    );
  });

  await t.test('configured referral limit combines with the separate welcome bonus cap', () => {
    const totalBalance = 500.00; // ₹300 welcome + ₹200 referral
    const welcomeBonus = 300.00;

    // Order of ₹1,200: ₹100 welcome + up to ₹100 referral = ₹200
    assert.equal(
      calculateTieredReferralWalletRedemption(totalBalance, 1200.00, [{ min_order_amount: 1000, referral_amount: 100 }], 1200.00, welcomeBonus),
      200,
      'Orders above ₹999 allow ₹100 welcome + ₹100 referral = ₹200'
    );

    // Order of ₹1,200 with only referral balance: gets ₹100
    assert.equal(
      calculateTieredReferralWalletRedemption(200.00, 1200.00, [{ min_order_amount: 1000, referral_amount: 100 }], 1200.00, 0),
      100,
      'The configured referral tier caps referral balance at ₹100'
    );

    // Order of ₹1,200 with only welcome bonus: gets ₹100
    assert.equal(
      calculateTieredReferralWalletRedemption(300.00, 1200.00, [], 1200.00, 300.00),
      100,
      'Welcome bonus capped at ₹100'
    );
  });

  await t.test('loyalty points redemption is strictly capped at 10% maximum', () => {
    const userPointsBalance = 10000;
    const eligibleAmount = 775.13;

    const result = calculateLoyaltyRedemption({
      pointsBalance: userPointsBalance,
      eligibleSubtotal: eligibleAmount,
      redemptionPointsPerRupee: 10,
      maxRedemptionPercent: 10,
      minimumRedemptionPoints: 100,
      enabled: true,
    });

    assert.ok(
      result.discount <= 77.51,
      `Loyalty discount (${result.discount}) must not exceed 10% cap (77.51)`
    );
    assert.equal(result.discount, 77.50);
    assert.equal(result.points, 775);
  });

  await t.test('end-to-end ₹999 purchase calculation with welcome bonus + coupon + tier + loyalty', () => {
    const subtotal = 999.00;

    // 1. Welcome bonus deduction: capped at ₹100 (referral ineligible)
    const walletDeduction = calculateTieredReferralWalletRedemption(500, subtotal, [{ min_order_amount: 1000, referral_amount: 100 }], subtotal, 300);
    assert.equal(walletDeduction, 100);

    // 2. 10% coupon
    const couponDiscount = 99.90;

    // 3. Platinum tier discount (3% of subtotal, bounded by remaining balance)
    const tierDiscount = calculateTierDiscount(subtotal, walletDeduction + couponDiscount, 3, true);
    assert.equal(tierDiscount, 29.97);

    // Post-tier eligible balance for points: 999 - 100 - 99.90 - 29.97 = 769.13
    const postTier = subtotal - walletDeduction - couponDiscount - tierDiscount;
    assert.equal(Math.round(postTier * 100) / 100, 769.13);

    // 4. Loyalty points capped at 10% of remaining 769.13 = max ₹76.90
    const loyalty = calculateLoyaltyRedemption({
      pointsBalance: 5000,
      eligibleSubtotal: postTier,
      redemptionPointsPerRupee: 10,
      maxRedemptionPercent: 10,
      minimumRedemptionPoints: 100,
      enabled: true,
    });
    assert.equal(loyalty.discount, 76.90);

    // 5. Final payable
    const totalDeductions = walletDeduction + couponDiscount + tierDiscount + loyalty.discount;
    const finalPayable = subtotal - totalDeductions;

    assert.equal(Math.round(totalDeductions * 100) / 100, 306.77);
    assert.equal(Math.round(finalPayable * 100) / 100, 692.23);
  });

  await t.test('end-to-end above ₹999 purchase (e.g. ₹1,200) with ₹100 welcome + ₹100 referral + extra coupon', () => {
    const subtotal = 1200.00;

    // 1. Above ₹999: ₹100 welcome bonus + ₹100 referral balance = ₹200
    const walletDeduction = calculateTieredReferralWalletRedemption(500, subtotal, [{ min_order_amount: 1000, referral_amount: 100 }], subtotal, 300);
    assert.equal(walletDeduction, 200);

    // 2. Extra coupon (e.g. ₹120 or 10%)
    const couponDiscount = 120.00;

    // 3. Platinum tier discount (3% of subtotal)
    const tierDiscount = calculateTierDiscount(subtotal, walletDeduction + couponDiscount, 3, true);
    assert.equal(tierDiscount, 36.00);

    // Post-tier eligible balance: 1200 - 200 - 120 - 36 = 844.00
    const postTier = subtotal - walletDeduction - couponDiscount - tierDiscount;
    assert.equal(postTier, 844.00);

    // 4. Loyalty points (10% of 844 = ₹84.40)
    const loyalty = calculateLoyaltyRedemption({
      pointsBalance: 5000,
      eligibleSubtotal: postTier,
      redemptionPointsPerRupee: 10,
      maxRedemptionPercent: 10,
      minimumRedemptionPoints: 100,
      enabled: true,
    });
    assert.equal(loyalty.discount, 84.40);

    // 5. Final payable
    const totalDeductions = walletDeduction + couponDiscount + tierDiscount + loyalty.discount;
    const finalPayable = subtotal - totalDeductions;

    assert.equal(Math.round(totalDeductions * 100) / 100, 440.40);
    assert.equal(Math.round(finalPayable * 100) / 100, 759.60);
  });
});
