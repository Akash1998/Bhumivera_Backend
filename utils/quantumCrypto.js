'use strict';

const crypto = require('crypto');

const DEFAULT_QUANTUM_PEPPER = 'bhumivera-512bit-quantum-shield-v1';

function getMasterSecret() {
  return (
    process.env.SUPPORT_QUANTUM_SECRET ||
    process.env.JWT_SECRET ||
    'bhumivera-enterprise-512bit-fallback-secret-key'
  );
}

/**
 * Derives 512-bit (64-byte) cryptographic key material using PBKDF2-HMAC-SHA512.
 */
function derive512BitKey(salt = DEFAULT_QUANTUM_PEPPER) {
  return crypto.pbkdf2Sync(getMasterSecret(), String(salt), 10000, 64, 'sha512');
}

/**
 * Computes a 512-bit (128-hex-character) HMAC-SHA512 tamper-proof signature
 * chained to the previous record hash.
 */
function computeQuantumHash512(payload, prevHash = 'GENESIS_512') {
  const key512 = derive512BitKey('audit-hash-chain-512');
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  return crypto
    .createHmac('sha512', key512)
    .update(`${prevHash || 'GENESIS_512'}|${serialized}`)
    .digest('hex');
}

/**
 * Constant-time verification of a 512-bit HMAC-SHA512 signature.
 */
function verifyQuantumSignature(payload, signatureHex, prevHash = 'GENESIS_512') {
  if (!signatureHex || typeof signatureHex !== 'string' || signatureHex.length !== 128) {
    return false;
  }
  const expectedHex = computeQuantumHash512(payload, prevHash);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedHex, 'hex'),
      Buffer.from(signatureHex, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Encrypts sensitive strings using 512-bit PBKDF2-SHA512 derived key material
 * (first 256 bits for AES-256-GCM encryption + last 256 bits for HMAC-SHA512 envelope integrity).
 */
function encryptQuantumPayload(plaintext) {
  if (plaintext === null || plaintext === undefined) return '';
  const iv = crypto.randomBytes(12);
  const salt = crypto.randomBytes(16);
  const key512 = derive512BitKey(salt.toString('hex'));
  const aesKey = key512.subarray(0, 32);
  const hmacKey = key512.subarray(32, 64);

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const envelopeData = `${salt.toString('hex')}.${iv.toString('hex')}.${authTag.toString('hex')}.${encrypted.toString('hex')}`;
  const mac512 = crypto.createHmac('sha512', hmacKey).update(envelopeData).digest('hex');
  return `q512:${envelopeData}.${mac512}`;
}

/**
 * Decrypts and verifies a `q512:` encrypted payload.
 */
function decryptQuantumPayload(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return '';
  if (!ciphertext.startsWith('q512:')) return ciphertext;
  try {
    const raw = ciphertext.slice(5);
    const parts = raw.split('.');
    if (parts.length !== 5) return '';
    const [saltHex, ivHex, tagHex, encHex, macHex] = parts;
    const key512 = derive512BitKey(saltHex);
    const aesKey = key512.subarray(0, 32);
    const hmacKey = key512.subarray(32, 64);

    const envelopeData = `${saltHex}.${ivHex}.${tagHex}.${encHex}`;
    const expectedMac = crypto.createHmac('sha512', hmacKey).update(envelopeData).digest('hex');
    if (
      macHex.length !== expectedMac.length ||
      !crypto.timingSafeEqual(Buffer.from(macHex, 'hex'), Buffer.from(expectedMac, 'hex'))
    ) {
      return '';
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      aesKey,
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

module.exports = {
  derive512BitKey,
  computeQuantumHash512,
  verifyQuantumSignature,
  encryptQuantumPayload,
  decryptQuantumPayload,
};
