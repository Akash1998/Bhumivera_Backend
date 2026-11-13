const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { parsePromoterProfileUrl } = require('../services/promoterProfileUrl');

describe('promoter profile URL validation', () => {
  it('detects only supported HTTPS profile URLs', () => {
    assert.deepEqual(parsePromoterProfileUrl('https://www.instagram.com/creator.name/'), {
      platform: 'Instagram',
      handle: '@creator.name',
    });
    assert.deepEqual(parsePromoterProfileUrl('https://youtube.com/@creatorchannel'), {
      platform: 'YouTube',
      handle: '@creatorchannel',
    });
    assert.deepEqual(parsePromoterProfileUrl('https://facebook.com/profile.php?id=123456'), {
      platform: 'Facebook',
      handle: '123456',
    });
  });

  it('rejects insecure, unsupported, or lookalike domains', () => {
    assert.equal(parsePromoterProfileUrl('http://instagram.com/creator'), null);
    assert.equal(parsePromoterProfileUrl('https://instagram.com.attacker.example/creator'), null);
    assert.equal(parsePromoterProfileUrl('https://youtube.com/watch?v=video-id'), null);
  });
});
