'use strict';

/**
 * ============================================================================
 * BHUMIVERA CLIENT CONCIERGE & FRICTION-RESCUE ENGINE
 * ============================================================================
 * Proactively diagnoses and resolves customer friction across the entire
 * storefront:
 *   1. Unable to Add to Cart / Quantity / Variant / Stock / Cart Rule issues
 *   2. Unable to Set Password / Reset Password / OTP / Login / Passkey issues
 *   3. Coupon / Promo / Loyalty / Referral / Checkout / Payment friction
 *   4. Order Tracking / Returns / Replacements / E-Warranty / GST Invoice links
 *   5. Complete A-to-Z Site Navigation & Missing Link Directory
 * ============================================================================
 */

let defaultPool = null; try { defaultPool = require('../config/db'); } catch { defaultPool = null; }
const { COMMON_PASSWORDS } = require('../utils/commonPasswords');

const PUBLIC_SITE_URL = (
  process.env.FRONTEND_URL ||
  process.env.PUBLIC_SITE_URL ||
  'https://www.bhumivera.com'
).replace(/\/+$/, '');

/**
 * Complete A-to-Z Website & Admin Navigation Map so the AI Co-Pilot can provide
 * exact clickable links for every single page, tool, policy, and portal.
 */
const COMPLETE_SITE_NAVIGATION_MAP = [
  {
    id: 'home',
    category: 'storefront',
    title: 'Bhumivera Home & Featured Botanical Collection',
    path: '/',
    url: `${PUBLIC_SITE_URL}/`,
    keywords: ['home', 'main page', 'featured', 'storefront', 'welcome', 'bhumivera'],
    description: 'Explore signature botanical formulations, seasonal offers, and verified customer stories.',
    steps: [
      'Open the home page to browse featured botanical formulations and active flash sales.',
      'Use the top navigation bar or search bar to jump to any category or product.',
    ],
  },
  {
    id: 'shop',
    category: 'storefront',
    title: 'Full Product Catalog & Category Filter (/shop)',
    path: '/shop',
    url: `${PUBLIC_SITE_URL}/shop`,
    keywords: ['shop', 'catalog', 'products', 'browse', 'filter', 'buy', 'all products', 'collection'],
    description: 'Browse all Bhumivera products with category, price, rating, and in-stock filters.',
    steps: [
      'Visit /shop and filter by Category, Price Range, Customer Rating, or In-Stock status.',
      'Click the Eye icon for Quick View, the Heart icon to save to Wishlist, or Add to Cart.',
    ],
  },
  {
    id: 'flash-sales',
    category: 'storefront',
    title: 'Limited-Time Flash Sales & Deals (/flash-sales)',
    path: '/flash-sales',
    url: `${PUBLIC_SITE_URL}/flash-sales`,
    keywords: ['flash sale', 'deals', 'discount', 'offer', 'sale', 'special offer'],
    description: 'View active time-limited promotional offers and discounted formulations.',
    steps: [
      'Open /flash-sales to see live countdown deals and remaining promotional stock.',
      'Add flash-sale items directly to your cart before the timer expires.',
    ],
  },
  {
    id: 'compare',
    category: 'storefront',
    title: 'Product Side-by-Side Comparison (/compare)',
    path: '/compare',
    url: `${PUBLIC_SITE_URL}/compare`,
    keywords: ['compare', 'comparison', 'difference', 'versus', 'vs'],
    description: 'Compare product ingredients, benefits, pricing, and ratings side by side.',
    steps: [
      'Select products to compare specifications, ratings, and pricing side by side.',
    ],
  },
  {
    id: 'wishlist',
    category: 'customer',
    title: 'Saved Wishlist (/wishlist)',
    path: '/wishlist',
    url: `${PUBLIC_SITE_URL}/wishlist`,
    keywords: ['wishlist', 'saved', 'favorites', 'heart', 'bookmark'],
    description: 'View your saved products and move them to your shopping cart with one click.',
    steps: [
      'Click the Heart icon on any product card to save it to your Wishlist.',
      'Open /wishlist anytime to move saved items straight into your cart.',
    ],
  },
  {
    id: 'checkout',
    category: 'checkout',
    title: 'Secure Checkout, Coupons & Loyalty Redemption (/checkout)',
    path: '/checkout',
    url: `${PUBLIC_SITE_URL}/checkout`,
    keywords: ['checkout', 'pay', 'payment', 'apply coupon', 'shipping address', 'place order', 'cod', 'upi'],
    description: 'Complete your order, apply promo codes, redeem loyalty points or referral credits, and select delivery speed.',
    steps: [
      'Select or add your delivery address (ensure a valid 6-digit Indian pincode and state).',
      'Apply an eligible coupon code or pick one from the Available Offers list.',
      'Choose Standard or Express delivery and complete payment via Online (UPI/Card/NetBanking) or COD.',
    ],
  },
  {
    id: 'order-tracking',
    category: 'orders',
    title: 'Live Order & Courier Tracking (/order-tracking)',
    path: '/order-tracking',
    url: `${PUBLIC_SITE_URL}/order-tracking`,
    keywords: ['track', 'tracking', 'order status', 'where is my order', 'bhvm', 'shipment', 'courier', 'awb'],
    description: 'Track any order in real time using your 9-digit Order Number (e.g., BHVM815899599) or AWB tracking number.',
    steps: [
      'Open /order-tracking and enter your 9-digit Order Number (with or without the BHVM prefix).',
      'View live shipment milestones, courier partner details, and estimated delivery date.',
    ],
  },
  {
    id: 'returns-centre',
    category: 'orders',
    title: 'Self-Service Returns & Replacements Centre (/returns-centre)',
    path: '/returns-centre',
    url: `${PUBLIC_SITE_URL}/returns-centre`,
    keywords: ['return', 'replace', 'replacement', 'exchange', 'refund', 'damaged', 'rma'],
    description: 'Initiate a return or replacement for delivered orders within the 7-day return window.',
    steps: [
      'Go to /returns-centre or Profile -> Orders and select your delivered order.',
      'Choose Return for Refund or Replacement, select the reason, and submit your RMA request.',
    ],
  },
  {
    id: 'ewarranty',
    category: 'authenticity',
    title: 'Product Authenticity & E-Warranty Registration (/ewarranty)',
    path: '/verify-product', url: `${PUBLIC_SITE_URL}/verify-product`, label: 'Verify Product Authenticity (/verify-product)', category: 'Authenticity & Warranty', description: 'Verify product batch authenticity and QR seal.', keywords: ['verify product', 'authentic', 'qr check'] },
  {
    id: 'ewarranty',
    path: '/ewarranty',
    url: `${PUBLIC_SITE_URL}/ewarranty`,
    keywords: ['warranty', 'ewarranty', 'serial', 'authentic', 'genuine', 'verify product', 'bhmv'],
    description: 'Verify your product serial hash and register your digital E-Warranty certificate.',
    steps: [
      'Locate the serial number on your product seal or packaging.',
      'Open /ewarranty, enter the serial number and purchase date, and activate your warranty.',
    ],
  },
  {
    id: 'provenance',
    category: 'authenticity',
    title: 'Botanical Provenance & Lab Purity Engine (/provenance)',
    path: '/provenance',
    url: `${PUBLIC_SITE_URL}/provenance`,
    keywords: ['provenance', 'lab report', 'purity', 'origin', 'batch', 'ingredients', 'science'],
    description: 'Inspect botanical sourcing, extraction standards, and batch quality verification.',
    steps: [
      'Visit /provenance or /science to explore batch sourcing and botanical purity testing.',
    ],
  },
  {
    id: 'science',
    category: 'authenticity',
    title: 'Bhumivera Botanical Science (/science)',
    path: '/science',
    url: `${PUBLIC_SITE_URL}/science`,
    keywords: ['science', 'research', 'formulation', 'ayurveda', 'clinical'],
    description: 'Learn how Bhumivera combines traditional botanical wisdom with modern cosmetic science science.',
    steps: [
      'Open /science to read detailed breakdowns of active botanical compounds.',
    ],
  },
  {
    id: 'impact',
    category: 'storefront',
    title: 'Bhumivera Earth Impact Ledger (/impact)',
    path: '/impact',
    url: `${PUBLIC_SITE_URL}/impact`,
    keywords: ['impact', 'earth', 'trees', 'sustainability', 'environment', 'river'],
    description: 'Track verified ecological restoration pledges, tree planting, and field reports.',
    steps: [
      'Visit /impact to view verified ecological contributions and on-ground field reports.',
    ],
  },
  {
    id: 'profile',
    category: 'account',
    title: 'Customer Account, Orders, Wallet, Loyalty & Security (/profile)',
    path: '/profile',
    url: `${PUBLIC_SITE_URL}/profile`,
    keywords: ['profile', 'account', 'my orders', 'wallet', 'loyalty points', 'referral', 'settings', 'security', 'passkey'],
    description: 'Manage your orders, downloadable GST tax invoices, spendable wallet, referral code, loyalty tier, addresses, and password/passkeys.',
    steps: [
      'Sign in and open /profile to access your Orders, Wallet, Clientele Privilege & Tiers, Brand Ambassador Program code, and Security settings.',
    ],
  },
  {
    id: 'address-book',
    category: 'account',
    title: 'Saved Delivery Addresses (/addresses)',
    path: '/addresses',
    url: `${PUBLIC_SITE_URL}/addresses`,
    keywords: ['address', 'addresses', 'shipping address', 'pincode', 'state'],
    description: 'Add, edit, or set your default shipping and billing addresses.',
    steps: [
      'Open /addresses to add or update your delivery address, state, and 6-digit pincode.',
    ],
  },
  {
    id: 'login',
    category: 'account',
    title: 'Customer Sign In (/login)',
    path: '/login',
    url: `${PUBLIC_SITE_URL}/login`,
    keywords: ['login', 'sign in', 'log in', 'passkey login'],
    description: 'Sign in to your Bhumivera account using your email & password or biometric Passkey.',
    steps: [
      'Visit /login and enter your registered email address and password, or click Sign in with Passkey.',
    ],
  },
  {
    id: 'register',
    category: 'account',
    title: 'Create New Customer Account (/register)',
    path: '/register',
    url: `${PUBLIC_SITE_URL}/register`,
    keywords: ['register', 'sign up', 'create account', 'new account', 'join'],
    description: 'Create a Bhumivera account to earn loyalty points, unlock referral rewards, and track orders.',
    steps: [
      'Open /register, enter your name, email, phone number, and a strong password (8+ chars with upper, lower, number, and symbol).',
    ],
  },
  {
    id: 'forgot-password',
    category: 'account',
    title: 'Password Recovery & OTP Reset (/forgot-password)',
    path: '/reset-password', url: `${PUBLIC_SITE_URL}/reset-password`, label: 'Set New Password (/reset-password)', category: 'Customer Account', description: 'Set a new password using a 6-digit OTP or 30-minute AI recovery token.', keywords: ['reset password', 'set password'] },
  {
    id: 'forgot_password',
    path: '/forgot-password',
    url: `${PUBLIC_SITE_URL}/forgot-password`,
    keywords: ['forgot password', 'reset password', 'password help', 'cant login', 'otp', 'recover account'],
    description: 'Reset a forgotten password using a 6-digit email verification code (OTP) or support reset link.',
    steps: [
      'Go to /forgot-password and enter your registered email address.',
      'Enter the 6-digit OTP sent to your email and choose a new strong password (8–72 characters).',
    ],
  },
  {
    id: 'support-center',
    category: 'support',
    title: 'Customer Help & Support Ticket Center (/support-center)',
    path: '/support-center',
    url: `${PUBLIC_SITE_URL}/support-center`,
    keywords: ['help', 'support center', 'faq', 'ticket', 'contact support', 'customer care'],
    description: 'Browse FAQs, open a support ticket, or chat live with the Bhumivera AI Concierge and Telegram bot.',
    steps: [
      'Visit /support-center or click the bottom-right AI Concierge button on any page.',
      'You can also continue your conversation on Telegram via @BhumiveraBot.',
    ],
  },
  {
    id: 'contact',
    category: 'support',
    title: 'Contact Concierge Desk (/contact)',
    path: '/contact',
    url: `${PUBLIC_SITE_URL}/contact`,
    keywords: ['contact', 'email us', 'phone', 'reach us', 'message'],
    description: 'Send a direct inquiry to the Bhumivera customer care team.',
    steps: [
      'Open /contact, fill in your name, email, subject, and message, and submit.',
    ],
  },
  {
    id: 'purchase-protection',
    category: 'policy',
    title: 'Bhumivera Purchase Protection & Authenticity Guarantee (/purchase-protection)',
    path: '/purchase-protection',
    url: `${PUBLIC_SITE_URL}/purchase-protection`,
    keywords: ['purchase protection', 'guarantee', 'buyer protection', 'safe checkout'],
    description: 'Read our 100% authenticity, transit damage protection, and hassle-free replacement policy.',
    steps: [
      'Visit /purchase-protection to review coverage for transit damage and authenticity verification.',
    ],
  },
  {
    id: 'legal',
    category: 'policy',
    title: 'Privacy Policy, Terms of Service & Refund Policy (/legal)',
    path: '/legal',
    url: `${PUBLIC_SITE_URL}/legal`,
    keywords: ['privacy', 'terms', 'legal', 'policy', 'shipping policy', 'refund policy'],
    description: 'Review Bhumivera terms of service, privacy protection, and statutory consumer policies.',
    steps: [
      'Open /legal to read full terms, privacy commitments, and return rules.',
    ],
  },
  {
    id: 'staff-support-portal',
    category: 'staff',
    title: 'Support Executive, Supervisor & Manager Portal (/support)',
    path: '/support',
    url: `${PUBLIC_SITE_URL}/support`,
    keywords: ['staff support', 'agent portal', 'support login', 'order verification'],
    description: 'Dedicated portal for Support Executives (L1), Supervisors (L2), and Managers (L3).',
    steps: [
      'Support staff sign in at /support to verify orders, reply to live Web/Telegram chats, and handle tickets.',
    ],
  },
  {
    id: 'superadmin-support-portal',
    category: 'staff',
    title: 'SuperAdmin Omnichannel Support Command Center (/superadminsupport)',
    path: '/admin/dashboard/gst', url: `${PUBLIC_SITE_URL}/admin/dashboard/gst`, label: 'Financial Ledger & GST Compliance (/admin/dashboard/gst)', category: 'Admin & Finance', description: 'Full GST portal, 48-col CSV export, 6-sheet Excel export, and Maison GST Tax Invoices.', keywords: ['gst', 'invoice', 'tax', 'gstr1', 'gstr3b'] },
  {
    id: 'superadmin_support',
    path: '/superadminsupport',
    url: `${PUBLIC_SITE_URL}/superadminsupport`,
    keywords: ['superadmin support', 'command center', 'delete ticket', 'delete chat', 'rbac'],
    description: 'SuperAdmin & Manager command center for omnichannel chats, ticket deletion, staff RBAC, and cryptographic audit logs.',
    steps: [
      'Sign in at /superadminsupport to manage all live chats, delete tickets/resolved chats, and configure @BhumiveraBot.',
    ],
  },
  {
    id: 'admin-dashboard',
    category: 'staff',
    title: 'Enterprise Admin Workspace & GST Portal (/admin/dashboard)',
    path: '/admin/dashboard',
    url: `${PUBLIC_SITE_URL}/admin/dashboard`,
    keywords: ['admin', 'dashboard', 'gst portal', 'invoice', 'coupons', 'inventory'],
    description: 'Full store administration including GST & Books, Luxury Tax Invoices, Coupons, Orders, Products, and Analytics.',
    steps: [
      'Sign in at /admin/login to access the Admin Workspace (/admin/dashboard) and GST Portal (/admin/dashboard/gst).',
    ],
  },
];

/**
 * Evaluates a candidate password against Bhumivera's security rules WITHOUT storing
 * or logging the password. Returns a structured diagnostic checklist so the AI
 * Co-Pilot can tell the customer the exact missing requirement.
 */
function evaluatePasswordRequirements(candidatePassword = '', email = '') {
  const pwd = String(candidatePassword || '');
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const emailLocal = normalizedEmail.split('@')[0] || '';

  const checks = [
    {
      id: 'min_length',
      label: 'At least 8 characters long (up to 72 characters)',
      passed: pwd.length >= 8 && pwd.length <= 72,
      fixHint: pwd.length < 8
        ? `Add ${8 - pwd.length} more character(s) so your password is at least 8 characters long.`
        : pwd.length > 72
        ? 'Shorten your password to 72 characters or fewer.'
        : 'Length requirement met.',
    },
    {
      id: 'uppercase',
      label: 'Contains at least one uppercase letter (A–Z)',
      passed: /[A-Z]/.test(pwd),
      fixHint: /[A-Z]/.test(pwd)
        ? 'Uppercase letter included.'
        : 'Add at least one capital letter (for example: A, B, M, or Z).',
    },
    {
      id: 'lowercase',
      label: 'Contains at least one lowercase letter (a–z)',
      passed: /[a-z]/.test(pwd),
      fixHint: /[a-z]/.test(pwd)
        ? 'Lowercase letter included.'
        : 'Add at least one lowercase letter (for example: a, b, m, or z).',
    },
    {
      id: 'number',
      label: 'Contains at least one digit (0–9)',
      passed: /\d/.test(pwd),
      fixHint: /\d/.test(pwd)
        ? 'Number included.'
        : 'Include at least one number (for example: 2, 7, or 9).',
    },
    {
      id: 'special',
      label: 'Contains at least one special character (!@#$%^&*)',
      passed: /[^A-Za-z0-9\s]/.test(pwd),
      fixHint: /[^A-Za-z0-9\s]/.test(pwd)
        ? 'Special symbol included.'
        : 'Add a special symbol such as !, @, #, $, %, or &.',
    },
    {
      id: 'not_common',
      label: 'Not a commonly breached or easily guessed password',
      passed: pwd.length > 0 && !COMMON_PASSWORDS.has(pwd.toLowerCase()),
      fixHint: pwd.length > 0 && COMMON_PASSWORDS.has(pwd.toLowerCase())
        ? 'This password appears on common breach lists. Combine 2–3 unique words with numbers and a symbol.'
        : 'Uniqueness check passed.',
    },
    {
      id: 'not_email_local',
      label: 'Does not match your email username',
      passed: !emailLocal || emailLocal.length < 3 || !pwd.toLowerCase().includes(emailLocal),
      fixHint: emailLocal && emailLocal.length >= 3 && pwd.toLowerCase().includes(emailLocal)
        ? 'Avoid including the first part of your email address inside your password.'
        : 'Does not repeat your email username.',
    },
  ];

  const passedCount = checks.filter(c => c.passed).length;
  const failedChecks = checks.filter(c => !c.passed);
  const isCompliant = failedChecks.length === 0;

  return {
    isCompliant,
    scorePercent: Math.round((passedCount / checks.length) * 100),
    checks,
    failedChecks,
    failedRules: failedChecks,
    suggestedFixes: failedChecks.map(c => c.fixHint),
    summaryMessage: isCompliant
      ? 'Your password meets all Bhumivera security requirements and is ready to save.'
      : `Almost there! Please fix ${failedChecks.length} item(s): ${failedChecks.map(c => c.fixHint).join(' ')}`,
    examplePattern: 'Botanical#2026! (Use a memorable phrase + capital letter + number + symbol)',
  };
}

/**
 * Diagnoses why a customer was unable to add a product to cart or update cart quantity,
 * queries live inventory & alternative in-stock products, and returns actionable
 * step-by-step guidance + 1-click rescue actions.
 */
async function diagnoseCartFriction({
  pool = defaultPool,
  productId = null,
  productName = '',
  requestedQuantity = 1,
  currentCartQuantity = 0,
  errorCode = '',
  errorMessage = '',
  selectedVariant = null,
} = {}) {
  const db = pool || defaultPool;
  let productRow = null;
  let alternatives = [];

  try {
    if (productId) {
      const [rows] = await db.query(
        `SELECT id, name, slug, sku, price, discount_price, stock, category_id, image_url, description
         FROM products WHERE id = ? LIMIT 1`,
        [productId]
      );
      productRow = rows?.[0] || null;
    } else if (productName) {
      const [rows] = await db.query(
        `SELECT id, name, slug, sku, price, discount_price, stock, category_id, image_url, description
         FROM products WHERE name LIKE ? LIMIT 1`,
        [`%${String(productName).trim()}%`]
      );
      productRow = rows?.[0] || null;
    }

    if (productRow) {
      const [altRows] = await db.query(
        `SELECT id, name, slug, sku, price, discount_price, stock, image_url
         FROM products
         WHERE stock > 0 AND id != ?
         ORDER BY (category_id = ?) DESC, stock DESC, id DESC
         LIMIT 4`,
        [productRow.id, productRow.category_id || 0]
      );
      alternatives = (altRows || []).map(p => ({
        id: p.id,
        name: p.name,
        slug: p.slug || String(p.id),
        price: Number(p.discount_price || p.price || 0),
        originalPrice: Number(p.price || 0),
        stock: Number(p.stock || 0),
        productUrl: `${PUBLIC_SITE_URL}/product/${p.slug || p.id}`,
      }));
    } else {
      const [altRows] = await db.query(
        `SELECT id, name, slug, sku, price, discount_price, stock, image_url
         FROM products
         WHERE stock > 0
         ORDER BY stock DESC, id DESC
         LIMIT 4`
      );
      alternatives = (altRows || []).map(p => ({
        id: p.id,
        name: p.name,
        slug: p.slug || String(p.id),
        price: Number(p.discount_price || p.price || 0),
        originalPrice: Number(p.price || 0),
        stock: Number(p.stock || 0),
        productUrl: `${PUBLIC_SITE_URL}/product/${p.slug || p.id}`,
      }));
    }
  } catch {
    // Non-fatal fallback if DB is mocked or unavailable
  }

  const availableStock = productRow ? Number(productRow.stock ?? 0) : null;
  const totalWanted = Number(currentCartQuantity || 0) + Number(requestedQuantity || 1);
  const errLower = `${errorCode} ${errorMessage}`.toLowerCase();

  let cause = 'general_cart_issue';
  let headline = 'Let me help you add this item to your cart';
  let explanation = '';
  let steps = [];
  let quickFixes = [];

  if (availableStock !== null && availableStock <= 0 || errLower.includes('out of stock') || errLower.includes('sold out')) {
    cause = 'out_of_stock';
    headline = `${productRow?.name || productName || 'This item'} is currently out of stock`;
    explanation = `Our live warehouse ledger shows 0 units currently available for immediate dispatch. You can pick an in-stock botanical alternative below or request a priority restock alert.`;
    steps = [
      'Choose one of the in-stock similar formulations recommended below to add to your cart immediately.',
      'Or click "Notify Me on Restock" so we message you the moment a fresh batch is bottled.',
    ];
    quickFixes = [
      { type: 'browse_alternatives', label: 'Browse In-Stock Alternatives', url: `${PUBLIC_SITE_URL}/shop` },
      { type: 'restock_alert', label: 'Notify Me When Back in Stock', productId: productRow?.id || productId },
    ];
  } else if (
    (availableStock !== null && totalWanted > availableStock) ||
    errLower.includes('exceed') ||
    errLower.includes('only') ||
    errLower.includes('available in stock')
  ) {
    cause = 'insufficient_stock_for_qty';
    const maxAddable = availableStock !== null ? Math.max(0, availableStock - Number(currentCartQuantity || 0)) : 1;
    headline = `Only ${availableStock ?? maxAddable} unit(s) available in stock`;
    explanation = `You requested ${totalWanted} unit(s), but our live inventory has ${availableStock ?? maxAddable} unit(s) ready to ship.`;
    steps = [
      maxAddable > 0
        ? `Click "Add ${maxAddable} Available Unit(s)" below to add the maximum available stock right now.`
        : `You already have all ${availableStock} available unit(s) of this product in your cart! Proceed to Checkout to secure them.`,
      'If you need a bulk or wholesale quantity, message our Concierge team for a custom batch allocation.',
    ];
    quickFixes = maxAddable > 0
      ? [
          {
            type: 'add_max_available',
            label: `Add ${maxAddable} Available Unit(s) Now`,
            productId: productRow?.id || productId,
            quantity: maxAddable,
          },
          { type: 'go_to_checkout', label: 'Proceed to Checkout', url: `${PUBLIC_SITE_URL}/checkout` },
        ]
      : [{ type: 'go_to_checkout', label: 'Proceed to Checkout Now', url: `${PUBLIC_SITE_URL}/checkout` }];
  } else if (errLower.includes('variant') || errLower.includes('option') || errLower.includes('size')) {
    cause = 'variant_required';
    headline = 'Please select a product option / pack size first';
    explanation = 'This formulation has multiple pack sizes or options. Selecting an option unlocks the Add to Cart button.';
    steps = [
      'Click on your preferred pack size or option badge above the Add to Cart button.',
      'Or click "Select Default Option & Add to Cart" below to add the standard size automatically.',
    ];
    quickFixes = [
      {
        type: 'select_default_variant',
        label: 'Select Standard Option & Add to Cart',
        productId: productRow?.id || productId,
        quantity: 1,
      },
    ];
  } else if (errLower.includes('network') || errLower.includes('timeout') || errLower.includes('500')) {
    cause = 'network_sync_error';
    headline = 'Temporary connection hiccup while syncing your cart';
    explanation = 'We saved your cart locally in your browser so you will not lose your selection.';
    steps = [
      'Click "Retry Add to Cart" below to re-sync your item.',
      'Your items remain safely stored in your local cart even if your connection briefly drops.',
    ];
    quickFixes = [
      {
        type: 'retry_add_to_cart',
        label: 'Retry Add to Cart',
        productId: productRow?.id || productId,
        quantity: Number(requestedQuantity || 1),
      },
    ];
  } else {
    cause = 'guided_cart_assist';
    headline = `Here is how to add ${productRow?.name || productName || 'items'} to your cart smoothly`;
    explanation = 'I checked our live catalog and verified your cart state so you can complete your order without friction.';
    steps = [
      'Verify your desired quantity (1 or more) and click "Add to Cart".',
      'Open the Mini-Cart drawer at the top right or go directly to /checkout to apply coupons and complete your order.',
    ];
    quickFixes = [
      ...(productRow
        ? [
            {
              type: 'retry_add_to_cart',
              label: `Add 1 × ${productRow.name} (₹${Number(productRow.discount_price || productRow.price || 0)})`,
              productId: productRow.id,
              quantity: 1,
            },
          ]
        : []),
      { type: 'open_shop', label: 'Browse All Products (/shop)', url: `${PUBLIC_SITE_URL}/shop` },
      { type: 'go_to_checkout', label: 'Go to Checkout (/checkout)', url: `${PUBLIC_SITE_URL}/checkout` },
    ];
  }

  return {
    success: true,
    frictionType: 'cart',
    cause,
    headline,
    explanation,
    steps,
    stepByStepGuide: steps,
    quickFixes,
    quickLinks: quickFixes,
    product: productRow
      ? {
          id: productRow.id,
          name: productRow.name,
          slug: productRow.slug || String(productRow.id),
          price: Number(productRow.discount_price || productRow.price || 0),
          stock: Number(productRow.stock || 0),
          productUrl: `${PUBLIC_SITE_URL}/product/${productRow.slug || productRow.id}`,
        }
      : null,
    alternatives,
  };
}

/**
 * Diagnoses password creation, password reset, OTP, or login difficulties and
 * returns interactive step-by-step guidance + direct recovery actions.
 */
async function diagnosePasswordAndAuthFriction({
  pool = defaultPool,
  email = '',
  candidatePassword = '',
  errorCode = '',
  errorMessage = '',
  stage = 'password_setup', // 'register' | 'login' | 'forgot_password' | 'reset_password' | 'profile_password'
} = {}) {
  const db = pool || defaultPool;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const errLower = `${errorCode} ${errorMessage}`.toLowerCase();

  let accountInfo = null;
  if (normalizedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    try {
      const [rows] = await db.query(
        'SELECT id, name, email, is_active, google_id FROM users WHERE LOWER(email) = ? LIMIT 1',
        [normalizedEmail]
      );
      if (rows?.[0]) {
        accountInfo = {
          exists: true,
          isActive: rows[0].is_active === undefined || Number(rows[0].is_active) === 1,
          hasGoogleAuth: Boolean(rows[0].google_id),
        };
      } else {
        accountInfo = { exists: false };
      }
    } catch {
      // ignore in mock environments
    }
  }

  const passwordCheck = candidatePassword
    ? evaluatePasswordRequirements(candidatePassword, normalizedEmail)
    : null;

  let cause = 'password_policy_guide';
  let headline = 'AI Password & Account Setup Guide';
  let explanation = 'Here is everything you need to set your password or recover your account smoothly:';
  let steps = [
    'Use 8 to 72 characters in total.',
    'Include at least 1 uppercase letter (A–Z), 1 lowercase letter (a–z), 1 number (0–9), and 1 symbol (such as !, @, #, $, %).',
    'Avoid common passwords (like Password123!) or using your email username inside your password.',
  ];
  let quickFixes = [
    { type: 'open_forgot_password', label: 'Reset Password with Email OTP (/forgot-password)', url: `${PUBLIC_SITE_URL}/forgot-password` },
    { type: 'open_login', label: 'Go to Sign In (/login)', url: `${PUBLIC_SITE_URL}/login` },
    { type: 'open_register', label: 'Create New Account (/register)', url: `${PUBLIC_SITE_URL}/register` },
  ];

  if (passwordCheck && !passwordCheck.isCompliant) {
    cause = 'password_rules_unmet';
    headline = 'Let’s fix your password so it passes security verification';
    explanation = passwordCheck.summaryMessage;
    steps = passwordCheck.failedChecks.map(c => `✗ ${c.label}: ${c.fixHint}`);
  } else if (errLower.includes('otp') || errLower.includes('expired') || errLower.includes('verification code')) {
    cause = 'otp_expired_or_invalid';
    headline = 'Trouble with your 6-digit verification code (OTP)?';
    explanation = 'Verification codes expire after 10 minutes and only the most recently requested code remains valid.';
    steps = [
      'Check both your primary inbox and your Spam/Promotions folder for the latest Bhumivera OTP email.',
      'Make sure you enter the newest 6-digit code without spaces.',
      'Click "Send Fresh Password Reset Link" below if you need a new code right away.',
    ];
    quickFixes = [
      { type: 'trigger_password_reset', label: 'Send Fresh Password Reset Email', email: normalizedEmail },
      { type: 'open_forgot_password', label: 'Open Password Recovery Page', url: `${PUBLIC_SITE_URL}/forgot-password` },
    ];
  } else if (errLower.includes('already exists') || errLower.includes('already registered') || (stage === 'register' && accountInfo?.exists)) {
    cause = 'account_already_exists';
    headline = 'An account with this email is already registered!';
    explanation = 'You do not need to register again — you can sign in directly or reset your password in 30 seconds.';
    steps = [
      'Click "Sign In to Existing Account" if you remember your password.',
      'Or click "Send Instant Password Reset" to set a fresh password for your email.',
    ];
    quickFixes = [
      { type: 'open_login', label: 'Sign In to Existing Account (/login)', url: `${PUBLIC_SITE_URL}/login` },
      { type: 'trigger_password_reset', label: 'Send Instant Password Reset Email', email: normalizedEmail },
    ];
  } else if (errLower.includes('invalid email or password') || errLower.includes('invalid credentials') || stage === 'login') {
    cause = 'login_credentials_mismatch';
    headline = 'Unable to sign in? Let’s get you back into your account';
    explanation = accountInfo?.exists === false
      ? `We did not find an existing account under "${normalizedEmail}". You can create a new account in seconds or check for a typo in your email.`
      : 'If your password is not working, you can reset it via a 6-digit email OTP, sign in with Google, or use a saved Passkey.';
    steps = accountInfo?.exists === false
      ? [
          'Double-check the spelling of your email address.',
          'Or click "Create Account" below to register a new Bhumivera account.',
        ]
      : [
          'Check that Caps Lock is turned off and there are no trailing spaces in your password.',
          'Click "Send Instant Password Reset Email" below to set a brand-new password.',
          'If you previously linked Google or a Passkey, you can also sign in with one click on /login.',
        ];
    quickFixes = [
      { type: 'trigger_password_reset', label: 'Send Instant Password Reset Email', email: normalizedEmail },
      { type: 'open_forgot_password', label: 'Open OTP Password Reset (/forgot-password)', url: `${PUBLIC_SITE_URL}/forgot-password` },
      { type: 'open_register', label: 'Create New Account (/register)', url: `${PUBLIC_SITE_URL}/register` },
    ];
  }

  return {
    success: true,
    frictionType: 'password_auth',
    cause,
    headline,
    explanation,
    steps,
    stepByStepGuide: steps,
    quickFixes,
    quickLinks: quickFixes,
    passwordDiagnostics: passwordCheck,
    accountInfo,
  };
}

/**
 * Diagnoses checkout, coupon, loyalty, or payment friction and recommends the
 * highest-saving eligible coupon for the customer's current cart.
 */
async function diagnoseCheckoutAndCouponFriction({
  pool = defaultPool,
  user = null,
  cartSubtotal = 0,
  couponCode = '',
  paymentMode = 'ONLINE',
  errorMessage = '',
} = {}) {
  const db = pool || defaultPool;
  const subtotal = Number(cartSubtotal || 0);
  const eligibleCoupons = [];

  try {
    const [rows] = await db.query(
      `SELECT id, code, discount_type, discount_value,
              COALESCE(min_order_amount, min_order_value, minimum_order_amount, 0) AS min_order_amount,
              max_discount_amount, usage_limit, COALESCE(per_user_limit, 1) AS per_user_limit,
              COALESCE(used_count, 0) AS used_count, COALESCE(first_order_only, 0) AS first_order_only,
              allowed_payment_modes, restricted_to_user_id, reward_type
       FROM coupons
       WHERE (status = 'active' OR status IS NULL)
         AND (is_active = 1 OR is_active IS NULL)
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (expiry_date IS NULL OR expiry_date > NOW())
         AND (usage_limit IS NULL OR COALESCE(used_count, 0) < usage_limit)
       ORDER BY discount_value DESC
       LIMIT 20`
    );

    for (const c of rows || []) {
      if (c.restricted_to_user_id && Number(c.restricted_to_user_id) !== Number(user?.id || 0)) {
        continue;
      }
      const minOrder = Number(c.min_order_amount || 0);
      const isEligibleNow = subtotal >= minOrder;
      const estimatedSavings =
        c.discount_type === 'percentage'
          ? Math.min(
              (subtotal * Number(c.discount_value || 0)) / 100,
              c.max_discount_amount ? Number(c.max_discount_amount) : Infinity
            )
          : Number(c.discount_value || 0);

      eligibleCoupons.push({
        code: c.code,
        discountType: c.discount_type,
        discountValue: Number(c.discount_value || 0),
        minOrderAmount: minOrder,
        maxDiscountAmount: c.max_discount_amount ? Number(c.max_discount_amount) : null,
        isEligibleNow,
        shortfallAmount: isEligibleNow ? 0 : Math.max(0, minOrder - subtotal),
        estimatedSavings: Math.max(0, Math.round(estimatedSavings * 100) / 100),
        rewardType: c.reward_type || 'standard',
      });
    }
  } catch {
    // ignore in mock environments
  }

  eligibleCoupons.sort((a, b) => {
    if (a.isEligibleNow !== b.isEligibleNow) return a.isEligibleNow ? -1 : 1;
    return b.estimatedSavings - a.estimatedSavings;
  });

  const bestCoupon = eligibleCoupons.find(c => c.isEligibleNow) || eligibleCoupons[0] || null;

  return {
    success: true,
    frictionType: 'checkout',
    headline: 'AI Checkout & Coupon Optimizer',
    explanation: errorMessage
      ? `I checked why "${couponCode || 'your checkout action'}" had an issue: ${errorMessage}`
      : bestCoupon?.isEligibleNow
      ? `Good news! Coupon ${bestCoupon.code} is eligible for your ₹${subtotal} cart and saves ₹${bestCoupon.estimatedSavings}.`
      : bestCoupon
      ? `Add ₹${bestCoupon.shortfallAmount} more to your cart to unlock coupon ${bestCoupon.code}!`
      : 'Your cart is ready for checkout. You can pay via UPI, Card, NetBanking, Wallet, or Cash on Delivery (for eligible accounts).',
    steps: [
      'Ensure your shipping address has a valid 6-digit pincode and Indian state.',
      bestCoupon?.isEligibleNow
        ? `Click "Apply ${bestCoupon.code}" to deduct ₹${bestCoupon.estimatedSavings} immediately.`
        : 'Enter an active promo code or toggle Loyalty Points / Referral Credits in the Order Summary.',
      'Remember: Each coupon code can be redeemed once per customer account (automatically restored if an order is cancelled).',
    ],
    bestCoupon,
    availableCoupons: eligibleCoupons.slice(0, 5),
    quickFixes: [
      ...(bestCoupon?.isEligibleNow
        ? [{ type: 'apply_coupon', label: `Apply Best Coupon (${bestCoupon.code})`, code: bestCoupon.code }]
        : []),
      { type: 'go_to_checkout', label: 'Open Checkout (/checkout)', url: `${PUBLIC_SITE_URL}/checkout` },
      { type: 'open_shop', label: 'Add More Items (/shop)', url: `${PUBLIC_SITE_URL}/shop` },
    ],
  };
}

/**
 * Searches the complete site navigation map for any customer query so the AI
 * can always provide missing links and step-by-step instructions.
 */
function findRelevantNavigationLinks(query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return COMPLETE_SITE_NAVIGATION_MAP.slice(0, 8);

  const scored = COMPLETE_SITE_NAVIGATION_MAP.map(item => {
    let score = 0;
    if (item.title.toLowerCase().includes(q)) score += 5;
    if (item.path.toLowerCase().includes(q)) score += 4;
    for (const kw of item.keywords) {
      if (q.includes(kw)) score += 6;
      else if (kw.includes(q) && q.length >= 3) score += 3;
    }
    return { item, score };
  });

  const matched = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.item);

  return matched.length > 0 ? matched.slice(0, 6) : COMPLETE_SITE_NAVIGATION_MAP.slice(0, 6);
}

/**
 * Unified AI Co-Pilot dispatcher for any customer friction event.
 */
async function diagnoseCustomerFriction(payload = {}, context = {}) {
  const frictionType = String(payload.frictionType || payload.type || 'general').toLowerCase();
  const pool = context.pool || defaultPool;
  const user = context.user || null;

  if (frictionType.includes('cart') || frictionType.includes('stock') || frictionType.includes('variant')) {
    return diagnoseCartFriction({
      pool,
      productId: payload.productId,
      productName: payload.productName,
      requestedQuantity: payload.requestedQuantity,
      currentCartQuantity: payload.currentCartQuantity,
      errorCode: payload.errorCode,
      errorMessage: payload.errorMessage,
      selectedVariant: payload.selectedVariant,
    });
  }

  if (
    frictionType.includes('password') ||
    frictionType.includes('login') ||
    frictionType.includes('auth') ||
    frictionType.includes('otp') ||
    frictionType.includes('register')
  ) {
    return diagnosePasswordAndAuthFriction({
      pool,
      email: payload.email || user?.email || '',
      candidatePassword: payload.candidatePassword || '',
      errorCode: payload.errorCode,
      errorMessage: payload.errorMessage,
      stage: payload.stage || frictionType,
    });
  }

  if (
    frictionType.includes('checkout') ||
    frictionType.includes('coupon') ||
    frictionType.includes('payment')
  ) {
    return diagnoseCheckoutAndCouponFriction({
      pool,
      user,
      cartSubtotal: payload.cartSubtotal,
      couponCode: payload.couponCode,
      paymentMode: payload.paymentMode,
      errorMessage: payload.errorMessage,
    });
  }

  const links = findRelevantNavigationLinks(payload.query || payload.errorMessage || payload.pagePath || '');
  return {
    success: true,
    frictionType: 'navigation_guide',
    headline: 'Bhumivera Client Concierge & Site Guide',
    explanation: 'I can guide you through adding items to cart, setting or resetting your password, applying coupons, tracking orders, downloading GST invoices, or navigating to any page on Bhumivera.',
    steps: [
      'Use the quick links below to jump directly to the page you need.',
      'If an item cannot be added to cart or a password fails validation, I will automatically diagnose the exact reason and offer a 1-click fix.',
    ],
    navigationLinks: links,
    quickFixes: links.slice(0, 4).map(l => ({
      type: 'navigate',
      label: l.title,
      url: l.url,
      path: l.path,
    })),
  };
}

module.exports = {
  COMPLETE_SITE_NAVIGATION_MAP,
  evaluatePasswordRequirements,
  diagnoseCartFriction,
  diagnosePasswordAndAuthFriction,
  diagnoseCheckoutAndCouponFriction,
  findRelevantNavigationLinks,
  diagnoseCustomerFriction,
};
