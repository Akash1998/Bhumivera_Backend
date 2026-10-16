'use strict';

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const { sendMail, getMailMetrics } = require('../utils/mail');
const { getRequestMetrics } = require('../middleware/requestObservability');
const { getModuleStates, isKnownModule, setModuleEnabled } = require('../utils/moduleAvailability');
const { getClientErrors } = require('../models/clientErrorModel');
const { getRazorpayClient } = require('../services/razorpayService');
const {
  fetchRailwayHttpErrors,
  fetchVercelDeploymentEvents,
  fetchVercelRuntimeLogs,
  getProviderConfiguration,
} = require('../utils/providerDiagnostics');
const {
  SUPERADMIN_EMAIL,
  PLATFORM_MODULES_CATALOG,
  ensureSuperAdminFortressTables,
  appendVaultAuditLog,
  getVaultStatus,
  createSuperAdminOtpChallenge,
  completeFirstTimeVaultOnboarding,
  verifySuperAdminMultiFactorLogin,
  verifyStepUpActionPasscode,
  listStaffAccountsWithMatrix,
  createStaffAccountWithMatrix,
  updateStaffAccountMatrix,
} = require('../models/superAdminVaultModel');
const {
  hashSecretFortress,
  normalizeSecurityAnswer,
  encryptVaultJson,
  generateCsrfToken,
  computeQuantumHash512,
} = require('../utils/fortressCrypto');
const {
  authenticateSuperAdminControlCentre,
  requireStepUpPasscode,
} = require('../middleware/rbacMatrixMiddleware');
const {
  executeAtomicOrderCancellationAndRefund,
  listWalletRefundLedger,
} = require('../services/walletRefundLedgerService');

const router = express.Router();

const vaultAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'VAULT_RATE_LIMIT_EXCEEDED',
    message: 'Too many SuperAdmin vault authentication attempts from this IP. Try again in 15 minutes.',
  },
});

const stepUpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'STEP_UP_RATE_LIMIT_EXCEEDED',
    message: 'Too many Step-Up Passcode verification attempts. Please wait 10 minutes.',
  },
});

function issueSuperAdminSessionAndCookie(req, res) {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    {
      id: 1,
      sub: '1',
      email: SUPERADMIN_EMAIL,
      name: 'Bhumivera Supreme SuperAdmin',
      role: 'superadmin',
      scope: 'superadmin-controlcentre',
    },
    process.env.JWT_SECRET || 'fallback_secret',
    {
      expiresIn: '8h',
      jwtid: jti,
    }
  );

  const csrfToken = generateCsrfToken(jti);
  const isProd = (process.env.NODE_ENV || 'production') === 'production';

  res.cookie('bv_sa_session', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
    path: '/',
  });

  return { token, csrfToken, jti };
}

/**
 * GET /api/superadmin/controlcentre/vault/status
 * Returns onboarding state and lockout status for `adminbhumivera27@gmail.com`.
 * NEVER exposes OTPs, hashes, or secret material.
 */
router.get('/vault/status', async (_req, res) => {
  try {
    const status = await getVaultStatus(pool);
    return res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    console.error('[SA_VAULT_STATUS_ERR]', error);
    return res.status(500).json({
      success: false,
      message: 'Could not read SuperAdmin Security Vault status.',
    });
  }
});

/**
 * POST /api/superadmin/controlcentre/vault/request-otp
 * Dispatches a 5-minute, max-3-attempt 6-Digit Email OTP exclusively to `adminbhumivera27@gmail.com`.
 * If already onboarded, returns the randomly selected rotating Security Question prompt.
 */
router.post('/vault/request-otp', vaultAuthLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const purpose = req.body?.purpose === 'onboarding' ? 'onboarding' : 'multi_factor_login';

    const challenge = await createSuperAdminOtpChallenge(pool, {
      email,
      purpose,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    // Dispatch live transactional email to adminbhumivera27@gmail.com
    try {
      await sendMail({
        to: SUPERADMIN_EMAIL,
        subject: '[Bhumivera Control Centre] Your 5-Minute SuperAdmin Security Vault Code',
        text: `Your Bhumivera SuperAdmin Control Centre verification code is ${challenge.rawOtp}. This code expires in 5 minutes and permits a maximum of 3 verification attempts.`,
        html: `
          <div style="font-family: Georgia, serif; background: #071510; color: #f4f1e9; padding: 32px; border-radius: 16px; border: 1px solid #d4af37;">
            <p style="font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: #d4af37; margin: 0 0 12px;">Bhumivera Maison · SuperAdmin Security Vault</p>
            <h2 style="margin: 0 0 16px; font-size: 22px; color: #ffffff;">Control Centre Verification Code</h2>
            <p style="font-size: 14px; line-height: 1.6; color: #d6dfd9;">Use the time-bound 6-digit verification code below to authenticate into <strong>/superadmin/controlcentre</strong>:</p>
            <div style="margin: 24px 0; padding: 16px 24px; background: #0b2419; border: 1px solid #d4af37; border-radius: 12px; display: inline-block; font-family: monospace; font-size: 28px; font-weight: bold; letter-spacing: 0.3em; color: #f3d77b;">
              ${challenge.rawOtp}
            </div>
            <p style="font-size: 12px; color: #9ab0a4; margin: 0;">Expires in <strong>5 minutes</strong> · Maximum <strong>3 attempts</strong> allowed.</p>
          </div>
        `,
        timeoutMs: 15000,
      });
    } catch (mailErr) {
      console.error('[SA_VAULT_OTP_MAIL_ERR]', mailErr.message);
      // Do not leak rawOtp in response; log delivery error for Railway administrator
    }

    // CRITICAL SECURITY DIRECTIVE: Never include rawOtp in the client response!
    return res.json({
      success: true,
      challengeId: challenge.challengeId,
      authorizedEmail: SUPERADMIN_EMAIL,
      isOnboarded: challenge.isOnboarded,
      purpose: challenge.purpose,
      expiresInSeconds: challenge.expiresInSeconds,
      maxAttempts: challenge.maxAttempts,
      securityQuestion: challenge.securityQuestion,
      message: `A 6-digit verification code has been dispatched to ${SUPERADMIN_EMAIL} (valid for 5 minutes, max 3 attempts).`,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({
      success: false,
      code: error.code || 'OTP_REQUEST_FAILED',
      secondsRemaining: error.secondsRemaining || undefined,
      message: error.message || 'Could not dispatch SuperAdmin verification code.',
    });
  }
});

/**
 * POST /api/superadmin/controlcentre/vault/onboarding-setup
 * First-Time Security Vault Setup Wizard for `adminbhumivera27@gmail.com`.
 * Saves Primary Master Password, Secondary Vault Password, 3 Security Questions & Answers, and 6-Digit Master Action Passcode.
 */
router.post('/vault/onboarding-setup', vaultAuthLimiter, async (req, res) => {
  try {
    const {
      challengeId,
      email,
      otp,
      primaryPassword,
      secondaryVaultPassword,
      securityQuestions,
      actionPasscode,
    } = req.body || {};

    await completeFirstTimeVaultOnboarding(pool, {
      challengeId,
      email,
      otp,
      primaryPassword,
      secondaryVaultPassword,
      securityQuestions,
      actionPasscode,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    const sessionData = issueSuperAdminSessionAndCookie(req, res);
    return res.status(201).json({
      success: true,
      token: sessionData.token,
      csrfToken: sessionData.csrfToken,
      superAdmin: {
        email: SUPERADMIN_EMAIL,
        role: 'superadmin',
        name: 'Bhumivera Supreme SuperAdmin',
      },
      message: 'SuperAdmin Security Vault initialized and cryptographically sealed.',
    });
  } catch (error) {
    const status = error.statusCode || 400;
    return res.status(status).json({
      success: false,
      code: error.code || 'ONBOARDING_FAILED',
      message: error.message || 'Could not complete Security Vault onboarding.',
    });
  }
});

/**
 * POST /api/superadmin/controlcentre/vault/verify-login
 * Standard Multi-Factor Login Flow:
 * Simultaneously verifies Email + 5-min OTP + Primary Password + Secondary Vault Password + Rotating Security Question + 6-Digit Action Passcode.
 */
router.post('/vault/verify-login', vaultAuthLimiter, async (req, res) => {
  try {
    const {
      challengeId,
      email,
      otp,
      primaryPassword,
      secondaryVaultPassword,
      securityAnswer,
      actionPasscode,
    } = req.body || {};

    await verifySuperAdminMultiFactorLogin(pool, {
      challengeId,
      email,
      otp,
      primaryPassword,
      secondaryVaultPassword,
      securityAnswer,
      actionPasscode,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    const sessionData = issueSuperAdminSessionAndCookie(req, res);
    return res.json({
      success: true,
      token: sessionData.token,
      csrfToken: sessionData.csrfToken,
      superAdmin: {
        email: SUPERADMIN_EMAIL,
        role: 'superadmin',
        name: 'Bhumivera Supreme SuperAdmin',
      },
      message: 'Multi-factor vault authentication verified.',
    });
  } catch (error) {
    const status = error.statusCode || 401;
    return res.status(status).json({
      success: false,
      code: error.code || 'VAULT_LOGIN_FAILED',
      secondsRemaining: error.secondsRemaining || undefined,
      message: error.message || 'SuperAdmin multi-factor verification failed.',
    });
  }
});

/**
 * POST /api/superadmin/controlcentre/vault/verify-step-up
 * Verifies the 6-Digit Master Action Passcode before executing destructive or state-changing operations.
 */
router.post(
  '/vault/verify-step-up',
  authenticateSuperAdminControlCentre,
  stepUpLimiter,
  async (req, res) => {
    try {
      const { actionPasscode, actionCode = 'STEP_UP_CHECK' } = req.body || {};
      const check = await verifyStepUpActionPasscode(pool, actionPasscode, {
        actionCode,
        targetEntity: req.body?.targetEntity || '/superadmin/controlcentre',
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
      if (!check.valid) {
        return res.status(403).json({
          success: false,
          code: check.code,
          message: check.message,
        });
      }
      return res.json({
        success: true,
        verifiedAt: new Date().toISOString(),
        message: '6-Digit Master Action Passcode verified.',
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: 'Could not verify Master Action Passcode.',
      });
    }
  }
);

/**
 * PUT /api/superadmin/controlcentre/vault/rotate-credentials
 * Allows the authenticated SuperAdmin (with valid current 6-Digit Action Passcode) to rotate Vault secrets.
 */
router.put(
  '/vault/rotate-credentials',
  authenticateSuperAdminControlCentre,
  requireStepUpPasscode('ROTATE_VAULT_CREDENTIALS'),
  async (req, res) => {
    try {
      const {
        newPrimaryPassword,
        newSecondaryVaultPassword,
        newSecurityQuestions,
        newActionPasscode,
      } = req.body || {};

      const updates = [];
      const params = [];

      if (newPrimaryPassword) {
        if (String(newPrimaryPassword).length < 10) {
          return res.status(400).json({ message: 'New Primary Master Password must be at least 10 characters.' });
        }
        updates.push('primary_password_hash = ?');
        params.push(hashSecretFortress(String(newPrimaryPassword), 'vault-primary-password'));
      }

      if (newSecondaryVaultPassword) {
        if (String(newSecondaryVaultPassword).length < 10) {
          return res.status(400).json({ message: 'New Secondary Vault Password must be at least 10 characters.' });
        }
        if (newPrimaryPassword && newPrimaryPassword === newSecondaryVaultPassword) {
          return res.status(400).json({ message: 'Primary and Secondary Vault passwords must be distinct.' });
        }
        updates.push('secondary_vault_password_hash = ?');
        params.push(hashSecretFortress(String(newSecondaryVaultPassword), 'vault-secondary-password'));
      }

      if (newActionPasscode) {
        if (!/^\d{6}$/.test(String(newActionPasscode).trim())) {
          return res.status(400).json({ message: 'New Master Action Passcode must be exactly 6 digits.' });
        }
        updates.push('action_passcode_hash = ?');
        params.push(hashSecretFortress(String(newActionPasscode).trim(), 'vault-action-passcode'));
      }

      if (Array.isArray(newSecurityQuestions) && newSecurityQuestions.length === 3) {
        const prepared = newSecurityQuestions.map((item, idx) => ({
          index: idx,
          question: String(item?.question || '').trim(),
          answerHash: hashSecretFortress(normalizeSecurityAnswer(item?.answer || ''), `vault-sec-q-${idx}`),
        }));
        updates.push('security_questions_encrypted = ?');
        params.push(encryptVaultJson(prepared));
      }

      if (!updates.length) {
        return res.status(400).json({ message: 'Provide at least one credential field to rotate.' });
      }

      params.push(SUPERADMIN_EMAIL);
      await pool.query(
        `UPDATE superadmin_security_vault SET ${updates.join(', ')} WHERE LOWER(authorized_email) = ?`,
        params
      );

      await appendVaultAuditLog(pool, {
        actorEmail: SUPERADMIN_EMAIL,
        actionCode: 'VAULT_CREDENTIALS_ROTATED',
        targetEntity: SUPERADMIN_EMAIL,
        payloadSummary: { fieldsUpdated: updates.length },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      return res.json({
        success: true,
        message: 'SuperAdmin Security Vault credentials rotated and re-encrypted.',
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Could not rotate Vault credentials.',
      });
    }
  }
);

/**
 * POST /api/superadmin/controlcentre/vault/logout
 */
router.post('/vault/logout', (_req, res) => {
  res.clearCookie('bv_sa_session', { path: '/' });
  return res.json({ success: true, message: 'Signed out of SuperAdmin Control Centre.' });
});

/**
 * GET /api/superadmin/controlcentre/overview
 * Single-Master Architecture orchestration payload for `/superadmin/controlcentre`.
 */
router.get('/overview', authenticateSuperAdminControlCentre, async (req, res) => {
  try {
    await ensureSuperAdminFortressTables(pool);

    const [
      moduleStates,
      staffAccounts,
      refundLedger,
      clientErrors,
      orderStatsResult,
      productStatsResult,
      escalationRowsResult,
      auditLogsResult,
    ] = await Promise.all([
      getModuleStates().catch(() => []),
      listStaffAccountsWithMatrix(pool).catch(() => []),
      listWalletRefundLedger(pool, { limit: 60 }).catch(() => []),
      getClientErrors(60).catch(() => []),
      pool.query(`
        SELECT COUNT(*) AS totalOrders,
               COALESCE(SUM(CASE WHEN status NOT IN ('cancelled', 'returned') THEN total ELSE 0 END), 0) AS activeRevenue,
               SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelledOrders,
               SUM(CASE WHEN status IN ('pending', 'confirmed', 'packed') THEN 1 ELSE 0 END) AS pendingFulfilment,
               SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) AS inTransit,
               SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS deliveredOrders
        FROM orders
      `).catch(() => [[{}]]),
      pool.query(`
        SELECT COUNT(*) AS totalProducts,
               SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeProducts,
               SUM(CASE WHEN quantity <= 5 THEN 1 ELSE 0 END) AS lowStockProducts
        FROM products
      `).catch(() => [[{}]]),
      pool.query(`
        SELECT t.*, u.name AS customer_name
        FROM support_escalation_tickets t
        LEFT JOIN users u ON u.id = t.user_id
        ORDER BY t.created_at DESC
        LIMIT 60
      `).catch(() => [[]]),
      pool.query(`
        SELECT * FROM superadmin_vault_audit_logs
        ORDER BY id DESC
        LIMIT 80
      `).catch(() => [[]]),
    ]);

    const orderStats = orderStatsResult?.[0]?.[0] || {};
    const productStats = productStatsResult?.[0]?.[0] || {};
    const escalationTickets = escalationRowsResult?.[0] || [];
    const auditLogs = auditLogsResult?.[0] || [];

    const requestMetrics = getRequestMetrics();
    const pauseByModuleId = new Map((moduleStates || []).map(m => [m.id, m]));

    // Enrich all 108 platform modules with live pause state & route telemetry
    const enrichedModules = PLATFORM_MODULES_CATALOG.map(mod => {
      const pauseInfo = mod.pauseKey ? pauseByModuleId.get(mod.pauseKey) : null;
      const routeStats = (requestMetrics.routeHealthTable || []).filter(r =>
        (mod.apiPrefixes || []).some(p => r.route === p || r.route.startsWith(`${p}/`))
      );
      const totalCalls = routeStats.reduce((acc, r) => acc + r.totalRequests, 0);
      const error5xx = routeStats.reduce((acc, r) => acc + r.status5xx, 0);
      const avgLatencyMs = routeStats.length
        ? Math.round(routeStats.reduce((acc, r) => acc + r.avgLatencyMs, 0) / routeStats.length)
        : 0;

      return {
        ...mod,
        enabled: pauseInfo ? Boolean(pauseInfo.enabled) : true,
        status: pauseInfo && !pauseInfo.enabled ? 'paused' : (error5xx > 0 ? 'degraded' : 'operational'),
        telemetry: {
          totalCalls,
          error5xx,
          avgLatencyMs,
        },
      };
    });

    const portals = [
      {
        id: 'storefront',
        name: 'Main Storefront',
        url: 'https://www.bhumivera.com',
        internalPath: '/products',
        status: 'operational',
        metrics: {
          activeProducts: Number(productStats.activeProducts || 0),
          totalProducts: Number(productStats.totalProducts || 0),
        },
        description: 'Public luxury botanical storefront, collection discovery, and rate-limited Client Concierge.',
      },
      {
        id: 'admin',
        name: 'Bhumivera Maison Executive Suite',
        url: 'https://www.bhumivera.com/admin/login',
        internalPath: '/admin',
        status: 'operational',
        metrics: {
          totalOrders: Number(orderStats.totalOrders || 0),
          activeRevenue: Number(orderStats.activeRevenue || 0),
        },
        description: 'Executive operations suite for Orders, Products, Financial Ledger & GST Compliance, Clientele Privilege & Tiers, and Bespoke Client Curation.',
      },
      {
        id: 'warehouse',
        name: 'Warehouse Portal',
        url: 'https://www.bhumivera.com/warehouse',
        internalPath: '/warehouse',
        status: 'operational',
        metrics: {
          pendingFulfilment: Number(orderStats.pendingFulfilment || 0),
          lowStockProducts: Number(productStats.lowStockProducts || 0),
        },
        description: 'Pick, pack, barcode serial verification, shipping labels, and reverse logistics intake.',
      },
      {
        id: 'support',
        name: 'Customer Support Desk',
        url: 'https://www.bhumivera.com/support',
        internalPath: '/support',
        status: 'operational',
        metrics: {
          openEscalations: escalationTickets.filter(t => t.status === 'open').length,
          totalEscalations: escalationTickets.length,
        },
        description: 'L1/L2 Support Desk for verified buyer threads, 12-hour callback/email escalations, and RMA creation (order cancellation disabled).',
      },
      {
        id: 'superadminsupport',
        name: 'SuperAdmin Support Center',
        url: 'https://www.bhumivera.com/superadminsupport',
        internalPath: '/superadminsupport',
        status: 'operational',
        metrics: {
          staffCount: staffAccounts.length,
          cancelledOrders: Number(orderStats.cancelledOrders || 0),
        },
        description: 'Senior Concierge & Telegram (@BhumiveraBot) command center, CSAT reviews, and transcript governance.',
      },
    ];

    return res.json({
      success: true,
      checkedAt: new Date().toISOString(),
      authorizedEmail: SUPERADMIN_EMAIL,
      portals,
      kpis: {
        totalModules: enrichedModules.length,
        operationalModules: enrichedModules.filter(m => m.status === 'operational').length,
        pausedModules: enrichedModules.filter(m => m.status === 'paused').length,
        staffAccountsCount: staffAccounts.length,
        activeStaffCount: staffAccounts.filter(s => s.isActive).length,
        totalOrders: Number(orderStats.totalOrders || 0),
        activeRevenue: Number(orderStats.activeRevenue || 0),
        cancelledOrders: Number(orderStats.cancelledOrders || 0),
        openEscalations: escalationTickets.filter(t => t.status === 'open').length,
        refundLedgerCount: refundLedger.length,
      },
      modulesCatalog: enrichedModules,
      modulePauseStates: moduleStates,
      staffAccounts,
      refundLedger,
      escalationTickets,
      telemetry: {
        requestMetrics,
        clientErrors,
        process: {
          uptimeSeconds: Math.floor(process.uptime()),
          ...process.memoryUsage(),
        },
        mailMetrics: getMailMetrics(),
      },
      auditLogs,
    });
  } catch (error) {
    console.error('[SA_CONTROL_CENTRE_OVERVIEW_ERR]', error);
    return res.status(500).json({
      success: false,
      message: 'Could not load SuperAdmin Control Centre overview.',
    });
  }
});

/**
 * GET /api/superadmin/controlcentre/telemetry
 * Live diagnostics for API Endpoint Health (200 OK vs 4xx/5xx, average latency ms),
 * Frontend (F12) Runtime Telemetry, and Vercel + Railway + MySQL Pool Health.
 */
router.get('/telemetry', authenticateSuperAdminControlCentre, async (req, res) => {
  let databaseHealth = { status: 'healthy', latencyMs: 0 };
  const dbStart = Date.now();
  try {
    await pool.query('SELECT 1');
    databaseHealth.latencyMs = Date.now() - dbStart;
  } catch (err) {
    databaseHealth = { status: 'unavailable', code: err.code || 'DB_ERROR', latencyMs: Date.now() - dbStart };
  }

  try {
    const requestMetrics = getRequestMetrics();
    const configuration = getProviderConfiguration();
    const diagnostics = req.app.locals.systemDiagnostics;

    const [clientErrors, dbEvents, railway, vercelRuntime, vercelEvents] = await Promise.all([
      getClientErrors(100).catch(() => []),
      diagnostics ? diagnostics.getRecentEvents(80).catch(() => []) : Promise.resolve([]),
      fetchRailwayHttpErrors().catch(err => ({
        configured: configuration.railway.configured,
        source: 'Railway HTTP logs',
        error: err.message,
        records: [],
      })),
      fetchVercelRuntimeLogs().catch(err => ({
        configured: configuration.vercel.configured,
        source: 'Vercel runtime logs',
        error: err.message,
        records: [],
      })),
      fetchVercelDeploymentEvents().catch(err => ({
        configured: configuration.vercel.configured,
        source: 'Vercel deployment events',
        error: err.message,
        records: [],
      })),
    ]);

    const poolConfig = pool.appConfig || {};
    return res.json({
      success: true,
      checkedAt: new Date().toISOString(),
      apiHealth: {
        windowMinutes: requestMetrics.windowMinutes,
        totalRequests: requestMetrics.requestCount,
        status2xxCount: requestMetrics.status2xxCount || 0,
        status4xxCount: requestMetrics.status4xxCount || 0,
        status5xxCount: requestMetrics.serverErrorCount || 0,
        avgLatencyMs: requestMetrics.averageLatencyMs || 0,
        routeHealthTable: requestMetrics.routeHealthTable || [],
        recentRequests: requestMetrics.recentRequests || [],
      },
      frontendTelemetry: {
        listenerActive: true,
        totalReports: clientErrors.length,
        reports: clientErrors,
      },
      infrastructure: {
        railway: {
          status: databaseHealth.status === 'healthy' ? 'connected' : 'degraded',
          uptimeSeconds: Math.floor(process.uptime()),
          memoryUsage: process.memoryUsage(),
          httpLogs: railway,
        },
        mysqlPool: {
          ...databaseHealth,
          connectionLimit: poolConfig.connectionLimit ?? 10,
          maxIdleConnections: poolConfig.maxIdle ?? 10,
          recentQueryFailures: dbEvents.filter(e => e.source === 'database'),
        },
        vercel: {
          configured: configuration.vercel.configured,
          runtimeLogs: vercelRuntime,
          deploymentEvents: vercelEvents,
        },
      },
    });
  } catch (error) {
    console.error('[SA_TELEMETRY_ERR]', error);
    return res.status(500).json({
      success: false,
      message: 'Could not load real-time telemetry diagnostics.',
    });
  }
});

/**
 * POST /api/superadmin/controlcentre/staff
 * Creates a new staff login (Admin, Warehouse, or Support) with granular per-module RBAC permissions.
 * Requires 6-Digit Master Action Passcode.
 */
router.post(
  '/staff',
  authenticateSuperAdminControlCentre,
  requireStepUpPasscode('CREATE_STAFF_ACCOUNT'),
  async (req, res) => {
    try {
      const staffId = await createStaffAccountWithMatrix(pool, {
        ...req.body,
        actorEmail: SUPERADMIN_EMAIL,
      });

      await appendVaultAuditLog(pool, {
        actorEmail: SUPERADMIN_EMAIL,
        actionCode: 'STAFF_ACCOUNT_CREATED',
        targetEntity: `staff:${staffId}`,
        payloadSummary: {
          username: req.body?.username,
          email: req.body?.email,
          primaryPortal: req.body?.primaryPortal,
          roleTitle: req.body?.roleTitle,
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      const staffAccounts = await listStaffAccountsWithMatrix(pool);
      return res.status(201).json({
        success: true,
        staffId,
        staffAccounts,
        message: `Created staff account '${req.body?.fullName || req.body?.username}'.`,
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Could not create staff login.',
      });
    }
  }
);

/**
 * PATCH /api/superadmin/controlcentre/staff/:staffId
 * Updates a staff member's profile or Dynamic Per-User Permission Matrix (`hidden`, `read`, `write`, `full`).
 * Requires 6-Digit Master Action Passcode.
 */
router.patch(
  '/staff/:staffId',
  authenticateSuperAdminControlCentre,
  requireStepUpPasscode('UPDATE_STAFF_PERMISSIONS'),
  async (req, res) => {
    try {
      const staffId = Number(req.params.staffId);
      await updateStaffAccountMatrix(pool, {
        staffId,
        ...req.body,
        actorEmail: SUPERADMIN_EMAIL,
      });

      await appendVaultAuditLog(pool, {
        actorEmail: SUPERADMIN_EMAIL,
        actionCode: 'STAFF_RBAC_MATRIX_UPDATED',
        targetEntity: `staff:${staffId}`,
        payloadSummary: {
          staffId,
          bulkCategory: req.body?.bulkCategory || null,
          bulkAccessLevel: req.body?.bulkAccessLevel || null,
          updatedKeysCount: Object.keys(req.body?.permissions || {}).length,
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      const staffAccounts = await listStaffAccountsWithMatrix(pool);
      return res.json({
        success: true,
        staffAccounts,
        message: 'Staff account and dynamic module permissions updated.',
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Could not update staff permissions.',
      });
    }
  }
);

/**
 * DELETE /api/superadmin/controlcentre/staff/:staffId
 * Permanently removes a staff account. Requires 6-Digit Master Action Passcode.
 */
router.delete(
  '/staff/:staffId',
  authenticateSuperAdminControlCentre,
  requireStepUpPasscode('DELETE_STAFF_ACCOUNT'),
  async (req, res) => {
    try {
      const staffId = Number(req.params.staffId);
      await pool.query('DELETE FROM staff_accounts WHERE id = ?', [staffId]);

      await appendVaultAuditLog(pool, {
        actorEmail: SUPERADMIN_EMAIL,
        actionCode: 'STAFF_ACCOUNT_DELETED',
        targetEntity: `staff:${staffId}`,
        payloadSummary: { deletedStaffId: staffId },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      const staffAccounts = await listStaffAccountsWithMatrix(pool);
      return res.json({
        success: true,
        staffAccounts,
        message: `Staff account #${staffId} deleted.`,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: 'Could not delete staff account.',
      });
    }
  }
);

/**
 * POST /api/superadmin/controlcentre/orders/:orderId/cancel
 * SuperAdmin Exclusive Order Cancellation + Atomic Refund & Wallet Restoration Ledger.
 * Requires 6-Digit Master Action Passcode.
 */
router.post(
  '/orders/:orderId/cancel',
  authenticateSuperAdminControlCentre,
  requireStepUpPasscode('SUPERADMIN_CANCEL_ORDER'),
  async (req, res) => {
    try {
      const orderId = req.params.orderId;
      const reason = String(req.body?.reason || 'Cancelled by SuperAdmin via Control Centre').trim();
      const refundDestinationPreference = req.body?.refundDestinationPreference || 'auto';

      const result = await executeAtomicOrderCancellationAndRefund(pool, {
        orderId,
        reason,
        refundDestinationPreference,
        executedByEmail: SUPERADMIN_EMAIL,
        razorpay: getRazorpayClient(),
      });

      await appendVaultAuditLog(pool, {
        actorEmail: SUPERADMIN_EMAIL,
        actionCode: 'ORDER_CANCELLED_WITH_ATOMIC_REFUND',
        targetEntity: `Order #${result.orderNumber}`,
        payloadSummary: result.refundSummary,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      const refundLedger = await listWalletRefundLedger(pool, { limit: 60 });
      return res.json({
        ...result,
        refundLedger,
        message: `Order #${result.orderNumber} cancelled. ${
          result.refundSummary.walletCreditedAmount > 0
            ? `₹${result.refundSummary.walletCreditedAmount.toFixed(2)} credited immediately to customer's Bhumivera Wallet (${result.ledgerReference}).`
            : result.refundSummary.gatewayRefundAmount > 0
            ? `Gateway refund of ₹${result.refundSummary.gatewayRefundAmount.toFixed(2)} initiated and recorded in ledger (${result.ledgerReference}).`
            : `Inventory and coupon redemptions restored (${result.ledgerReference}).`
        }`,
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        code: error.code || 'ORDER_CANCEL_FAILED',
        message: error.message || 'Could not cancel order.',
      });
    }
  }
);

/**
 * PATCH /api/superadmin/controlcentre/modules/:moduleId/pause
 * Pauses or resumes a platform API module. Requires 6-Digit Master Action Passcode.
 */
router.patch(
  '/modules/:moduleId/pause',
  authenticateSuperAdminControlCentre,
  requireStepUpPasscode('TOGGLE_MODULE_AVAILABILITY'),
  async (req, res) => {
    try {
      const { moduleId } = req.params;
      const { enabled } = req.body || {};
      if (!isKnownModule(moduleId)) {
        return res.status(404).json({ code: 'UNKNOWN_MODULE', message: 'Module is not registered in switchboard.' });
      }
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ message: 'enabled must be true or false.' });
      }
      await setModuleEnabled(moduleId, enabled);

      await appendVaultAuditLog(pool, {
        actorEmail: SUPERADMIN_EMAIL,
        actionCode: enabled ? 'MODULE_RESUMED' : 'MODULE_PAUSED',
        targetEntity: moduleId,
        payloadSummary: { moduleId, enabled },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      const moduleStates = await getModuleStates();
      return res.json({
        success: true,
        moduleId,
        enabled,
        moduleStates,
        message: `Module '${moduleId}' ${enabled ? 'resumed' : 'paused'}.`,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: 'Could not update module state.',
      });
    }
  }
);

/**
 * PATCH /api/superadmin/controlcentre/escalations/:ticketId
 * Updates status or resolution notes on a verified customer escalation ticket.
 */
router.patch(
  '/escalations/:ticketId',
  authenticateSuperAdminControlCentre,
  async (req, res) => {
    try {
      const ticketId = Number(req.params.ticketId);
      const { status, resolutionNotes } = req.body || {};
      const validStatuses = ['open', 'assigned', 'in_progress', 'resolved', 'closed'];
      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({ message: 'Invalid escalation status.' });
      }

      await pool.query(
        `UPDATE support_escalation_tickets
         SET status = COALESCE(?, status),
             resolution_notes = COALESCE(?, resolution_notes)
         WHERE id = ?`,
        [status || null, resolutionNotes || null, ticketId]
      );

      const [rows] = await pool.query(
        `SELECT t.*, u.name AS customer_name
         FROM support_escalation_tickets t
         LEFT JOIN users u ON u.id = t.user_id
         ORDER BY t.created_at DESC
         LIMIT 60`
      );

      return res.json({
        success: true,
        escalationTickets: rows || [],
        message: `Escalation ticket #${ticketId} updated.`,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: 'Could not update escalation ticket.',
      });
    }
  }
);

module.exports = router;
