'use strict';

const crypto = require('crypto');
const {
  derive512BitKey,
  computeQuantumHash512,
  encryptQuantumPayload,
  decryptQuantumPayload,
} = require('./quantumCrypto');

const PBKDF2_ITERATIONS = 210000;
const KEY_LENGTH_BYTES = 64; // 512 bits
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function getFortressPepper() {
  return (
    process.env.SUPERADMIN_VAULT_SECRET ||
    process.env.SUPPORT_QUANTUM_SECRET ||
    process.env.JWT_SECRET ||
    'bhumivera-maison-fortress-512bit-master-pepper-v2'
  );
}

/**
 * Normalizes a security question answer so whitespace/casing variations remain deterministic
 * before cryptographic hashing.
 */
function normalizeSecurityAnswer(rawAnswer) {
  return String(rawAnswer || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Hashes a password, security answer, or 6-digit passcode using a dual-layered
 * memory-hard Scrypt + PBKDF2-HMAC-SHA512 (210,000 iterations) KDF with a unique 32-byte salt.
 */
function hashSecretFortress(rawSecret, domain = 'vault-credential') {
  if (typeof rawSecret !== 'string' || !rawSecret.length) {
    throw new Error('Cannot hash an empty secret.');
  }
  const salt = crypto.randomBytes(32);
  const pepperedInput = crypto
    .createHmac('sha512', getFortressPepper())
    .update(`${domain}:${rawSecret}`)
    .digest();

  const scryptDerived = crypto.scryptSync(pepperedInput, salt, KEY_LENGTH_BYTES, SCRYPT_PARAMS);
  const finalDigest = crypto.pbkdf2Sync(
    scryptDerived,
    Buffer.concat([salt, Buffer.from(`:${domain}`, 'utf8')]),
    PBKDF2_ITERATIONS,
    KEY_LENGTH_BYTES,
    'sha512'
  );

  return `bvfortress$v1$${ domain }$${PBKDF2_ITERATIONS}$${salt.toString('hex')}$${finalDigest.toString('hex')}`;
}

/**
 * Verifies a candidate secret against a stored `bvfortress$v1$...` hash in constant time.
 */
function verifySecretFortress(candidateSecret, storedHash, expectedDomain = null) {
  if (
    typeof candidateSecret !== 'string' ||
    !candidateSecret.length ||
    typeof storedHash !== 'string' ||
    !storedHash.startsWith('bvfortress$v1$')
  ) {
    return false;
  }
  try {
    const parts = storedHash.split('$');
    if (parts.length !== 6) return false;
    const [, , domain, iterStr, saltHex, digestHex] = parts;
    if (expectedDomain && domain !== expectedDomain) return false;

    const iterations = Number.parseInt(iterStr, 10);
    if (!Number.isSafeInteger(iterations) || iterations < 10000 || iterations > 1000000) {
      return false;
    }

    const salt = Buffer.from(saltHex, 'hex');
    const expectedBuf = Buffer.from(digestHex, 'hex');
    if (salt.length !== 32 || expectedBuf.length !== KEY_LENGTH_BYTES) return false;

    const pepperedInput = crypto
      .createHmac('sha512', getFortressPepper())
      .update(`${domain}:${candidateSecret}`)
      .digest();

    const scryptDerived = crypto.scryptSync(pepperedInput, salt, KEY_LENGTH_BYTES, SCRYPT_PARAMS);
    const candidateDigest = crypto.pbkdf2Sync(
      scryptDerived,
      Buffer.concat([salt, Buffer.from(`:${domain}`, 'utf8')]),
      iterations,
      KEY_LENGTH_BYTES,
      'sha512'
    );

    return crypto.timingSafeEqual(candidateDigest, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Encrypts a JSON object using AES-256-GCM + SHA-512 HMAC authenticated envelope.
 */
function encryptVaultJson(data) {
  const serialized = JSON.stringify(data ?? {});
  return encryptQuantumPayload(serialized);
}

/**
 * Decrypts and parses an AES-256-GCM + SHA-512 HMAC encrypted JSON envelope.
 */
function decryptVaultJson(ciphertext, fallback = null) {
  if (!ciphertext || typeof ciphertext !== 'string') return fallback;
  const decrypted = decryptQuantumPayload(ciphertext);
  if (!decrypted) return fallback;
  try {
    return JSON.parse(decrypted);
  } catch {
    return fallback;
  }
}

/**
 * Generates a cryptographically bound CSRF token for a given session identifier.
 */
function generateCsrfToken(sessionId) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const key = derive512BitKey('csrf-protection-v1');
  const mac = crypto
    .createHmac('sha512', key)
    .update(`${sessionId || 'anon'}:${nonce}`)
    .digest('hex')
    .slice(0, 64);
  return `${nonce}.${mac}`;
}

/**
 * Verifies a CSRF token in constant time against the active session identifier.
 */
function verifyCsrfToken(csrfToken, sessionId) {
  if (!csrfToken || typeof csrfToken !== 'string' || !csrfToken.includes('.')) {
    return false;
  }
  const [nonce, mac] = csrfToken.split('.');
  if (!nonce || !mac || mac.length !== 64) return false;
  const key = derive512BitKey('csrf-protection-v1');
  const expectedMac = crypto
    .createHmac('sha512', key)
    .update(`${sessionId || 'anon'}:${nonce}`)
    .digest('hex')
    .slice(0, 64);
  try {
    return crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expectedMac, 'hex'));
  } catch {
    return false;
  }
}

module.exports = {
  hashSecretFortress,
  verifySecretFortress,
  normalizeSecurityAnswer,
  encryptVaultJson,
  decryptVaultJson,
  generateCsrfToken,
  verifyCsrfToken,
  computeQuantumHash512,
};
