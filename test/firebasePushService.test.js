const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isFirebasePushConfigured,
  sendPushToTokens,
} = require('../services/firebasePushService');

test('reports Firebase push as configured only when project and matching credentials exist', () => {
  const envBackup = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  };
  try {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    assert.equal(isFirebasePushConfigured(), false);

    process.env.FIREBASE_PROJECT_ID = 'test-project';
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: 'test-project',
      client_email: 'push@test-project.iam.gserviceaccount.com',
      private_key: 'test-private-key',
    });
    assert.equal(isFirebasePushConfigured(), true);

    process.env.FIREBASE_PROJECT_ID = 'another-project';
    assert.equal(isFirebasePushConfigured(), false);
  } finally {
    if (envBackup.projectId === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = envBackup.projectId;
    if (envBackup.serviceAccount === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = envBackup.serviceAccount;
    if (envBackup.credentialsPath === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = envBackup.credentialsPath;
  }
});

test('sends push notification content and string data to FCM', async () => {
  let request;
  const messaging = {
    sendEachForMulticast: async value => {
      request = value;
      return {
        successCount: 1,
        failureCount: 0,
        responses: [{ success: true }],
      };
    },
  };

  const sent = await sendPushToTokens(
    messaging,
    ['device-token'],
    { title: 'Order confirmed', message: 'Order #123 is confirmed.' },
    { notificationId: 12, route: '/profile?tab=notifications' }
  );

  assert.equal(sent, 1);
  assert.deepEqual(request.tokens, ['device-token']);
  assert.deepEqual(request.notification, {
    title: 'Order confirmed',
    body: 'Order #123 is confirmed.',
  });
  assert.deepEqual(request.data, {
    notificationId: '12',
    route: '/profile?tab=notifications',
  });
  assert.equal(request.android.priority, 'high');
});

test('splits FCM multicast sends into batches of at most 500 tokens', async () => {
  const batchSizes = [];
  const messaging = {
    sendEachForMulticast: async ({ tokens }) => {
      batchSizes.push(tokens.length);
      return {
        successCount: tokens.length,
        failureCount: 0,
        responses: tokens.map(() => ({ success: true })),
      };
    },
  };

  const sent = await sendPushToTokens(
    messaging,
    Array.from({ length: 1001 }, (_, index) => `token-${index}`),
    { title: 'Update', message: 'A new update is available.' }
  );

  assert.equal(sent, 1001);
  assert.deepEqual(batchSizes, [500, 500, 1]);
});
