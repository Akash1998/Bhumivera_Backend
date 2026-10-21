const common = require('./utils/commonPasswords');
const disp = require('./utils/disposableEmails');
const policy = require('./utils/passwordPolicy');
const hibp = require('./utils/hibp');
const jti = require('./utils/jtiCache');

const assert = require('assert');

console.log('=== SMOKE T2 ===');
console.log('COMMON_PASSWORDS set size =', common.COMMON_PASSWORDS.size);
assert.ok(common.COMMON_PASSWORDS.size >= 1000, 'Need >=1000 common passwords');
console.log('DISPOSABLE_DOMAINS set size =', disp.DISPOSABLE_DOMAINS.size);
assert.ok(disp.DISPOSABLE_DOMAINS.size >= 500, 'Need >=500 disposable domains');
console.log('hibp exports =', Object.keys(hibp));
console.log('policy exports =', Object.keys(policy));
console.log('jti exports =', Object.keys(jti));

assert.strictEqual(common.isCommonPassword('password1'), true, 'password1 should be common');
assert.strictEqual(common.isCommonPassword('Tr0ub4dor&3-sdlkfjsdlkjfs!'), false, 'strong unique should NOT be common');

assert.strictEqual(disp.isDisposableEmail('a@gmail.com'), false);
assert.strictEqual(disp.isDisposableEmail('a@mailinator.com'), true);
assert.strictEqual(disp.isDisposableEmail('a@foo.mailinator.com'), true);
assert.strictEqual(disp.isDisposableEmail('a@yopmail.com'), true);
assert.strictEqual(disp.isDisposableEmail('a@protonmail.com'), false);

const weak = policy.validatePasswordBasic('password');
console.log('weak "password" valid?', weak.valid, 'errors:', weak.errors.map(e=>e.code));
assert.strictEqual(weak.valid, false);

const weak2 = policy.validatePasswordBasic('hello world 123');
console.log('weak2 valid?', weak2.valid, 'score:', weak2.score, 'errors:', weak2.errors.map(e=>e.code));
assert.strictEqual(weak2.valid, false);

const good = policy.validatePasswordBasic('MyStr0ng!Passphrase#2026');
console.log('good valid?', good.valid, 'score:', good.score, 'errors:', good.errors.map(e=>e.code));
assert.strictEqual(good.valid, true);
assert.ok(good.score >= 3, 'score should be >=3');

jti.markRevoked('abc123');
assert.strictEqual(jti.isRevoked('abc123'), true, 'revoked jti should be blocked');
assert.strictEqual(jti.isRevoked('def456'), false, 'unknown jti should pass');

console.log('T2 SMOKE: ALL PASS');
process.exit(0);
