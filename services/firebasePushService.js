const { applicationDefault, cert, getApps, initializeApp } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  getAllActiveTokens,
  getTokensForUser,
  unregisterDeviceToken,
} = require('../models/deviceTokenModel');

let messagingClient = null;

const isFirebasePushConfigured = () => {
  if (!process.env.FIREBASE_PROJECT_ID) return false;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      return Boolean(
        account.project_id === process.env.FIREBASE_PROJECT_ID &&
        account.client_email &&
        account.private_key
      );
    } catch {
      return false;
    }
  }
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return Boolean(credentialsPath && existsSync(resolve(credentialsPath)));
};

const getMessagingClient = () => {
  if (messagingClient) return messagingClient;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const serviceAccountValue = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!projectId || (!serviceAccountValue && !credentialsPath)) return null;

  let credential;
  if (serviceAccountValue) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountValue);
    } catch (error) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON.', { cause: error });
    }
    if (!serviceAccount.client_email || !serviceAccount.private_key || !serviceAccount.project_id) {
      throw new Error('Firebase service-account JSON must include project_id, client_email, and private_key.');
    }
    if (serviceAccount.project_id !== projectId) {
      throw new Error('FIREBASE_PROJECT_ID must match the project_id in the Firebase service-account JSON.');
    }
    credential = cert({
      ...serviceAccount,
      projectId,
      privateKey: serviceAccount.private_key.replace(/\\n/g, '\n'),
    });
  } else {
    credential = applicationDefault();
  }

  const app = getApps().find(existing => existing.name === 'bhumivera-push') ||
    initializeApp({ credential, projectId }, 'bhumivera-push');
  messagingClient = getMessaging(app);
  return messagingClient;
};

const deactivateInvalidTokens = async (tokens, responses) => {
  const invalidTokenCodes = new Set([
    'messaging/invalid-registration-token',
    'messaging/registration-token-not-registered',
  ]);
  const removals = responses.flatMap((response, index) =>
    !response.success && invalidTokenCodes.has(response.error?.code)
      ? [unregisterDeviceToken(tokens[index])]
      : []
  );
  const results = await Promise.allSettled(removals);
  results.forEach(result => {
    if (result.status === 'rejected') {
      console.error('[PUSH_INVALID_TOKEN_DEACTIVATION_FAILED]', result.reason);
    }
  });
};

const sendPushToTokens = async (messaging, tokens, notification, data = {}) => {
  let sent = 0;
  for (let offset = 0; offset < tokens.length; offset += 500) {
    const batch = tokens.slice(offset, offset + 500);
    const result = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: {
        title: String(notification.title || 'Bhumivera'),
        body: String(notification.message || ''),
      },
      data: Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, String(value)])
      ),
      android: { priority: 'high' },
    });
    sent += result.successCount;
    await deactivateInvalidTokens(batch, result.responses);
    if (result.failureCount) {
      console.error('[PUSH_DELIVERY_PARTIAL_FAILURE]', {
        failed: result.failureCount,
        sent: result.successCount,
      });
    }
  }
  return sent;
};

const sendStoredNotification = async ({ notificationId, userId, title, message, isGlobal = false }) => {
  const messaging = getMessagingClient();
  if (!messaging) {
    return { sent: 0, skipped: true };
  }

  const tokenRows = isGlobal
    ? await getAllActiveTokens()
    : userId
      ? await getTokensForUser(userId)
      : [];
  const tokens = [...new Set(tokenRows.map(row => row.token).filter(Boolean))];
  if (tokens.length === 0) return { sent: 0, skipped: false };

  const sent = await sendPushToTokens(messaging, tokens, { title, message }, {
    notificationId,
    route: '/profile?tab=notifications',
  });
  return { sent, skipped: false };
};

module.exports = {
  sendStoredNotification,
  sendPushToTokens,
  getMessagingClient,
  isFirebasePushConfigured,
};
