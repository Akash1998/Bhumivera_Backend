const assert = require('node:assert/strict');
const { beforeEach, describe, it } = require('node:test');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;
const servicePath = path.resolve(__dirname, '../services/impactDonationService.js');
const state = { mail: null, failMail: false, certificateSentAt: null };
Module._load = function (request, parent, isMain) {
  if (parent?.filename === servicePath && request === '../utils/mail') {
    return {
      sendMail: async mail => {
        if (state.failMail) throw new Error('Mail provider unavailable');
        state.mail = mail;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { sendImpactCertificateForContribution } = require(servicePath);
Module._load = originalLoad;

const createPool = () => ({
  async query(sql) {
    if (sql.includes('SELECT ic.*')) {
      return [[{
        id: 44,
        user_id: 17,
        project_key: 'hungry-feeding',
        amount: '100.00',
        payment_id: 'pay_impact_123',
        certificate_code: 'BV-HUNG-TEST-01',
        dedication: 'For the community',
        certificate_sent_at: state.certificateSentAt,
        customer_name: 'Meera Iyer',
        customer_email: 'registered@example.com',
      }]];
    }
    if (sql.includes('UPDATE impact_contributions SET certificate_sent_at')) {
      state.certificateSentAt = '2026-10-18T12:01:00.000Z';
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  },
});

beforeEach(() => {
  state.mail = null;
  state.failMail = false;
  state.certificateSentAt = null;
});

describe('impact contribution certificate delivery', () => {
  it('emails the verified co-sponsorship certificate to the registered account address', async () => {
    const sent = await sendImpactCertificateForContribution(createPool(), 44);

    assert.equal(sent, true);
    assert.equal(state.mail.to, 'registered@example.com');
    assert.match(state.mail.subject, /Stewardship Certificate/);
    assert.match(state.mail.html, /Meera Iyer/);
    assert.match(state.mail.html, /Warm Meal Annadaan &amp; Hunger Relief Kitchen/);
    assert.match(state.mail.html, /BV-HUNG-TEST-01/);
    assert.equal(state.certificateSentAt, '2026-10-18T12:01:00.000Z');
  });

  it('leaves email delivery retryable when the mail provider fails', async () => {
    state.failMail = true;
    const sent = await sendImpactCertificateForContribution(createPool(), 44);

    assert.equal(sent, false);
    assert.equal(state.certificateSentAt, null);
  });
});
