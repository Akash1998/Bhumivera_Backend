const crypto = require('crypto');

const CARRIER_CREDENTIALS_KEY = 'CARRIER_CREDENTIALS_KEY';

const getEncryptionKey = () => {
  const value = process.env[CARRIER_CREDENTIALS_KEY];
  if (!value) throw new Error(`${CARRIER_CREDENTIALS_KEY} must be configured before saving carrier credentials.`);
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${CARRIER_CREDENTIALS_KEY} must be a 64-character hexadecimal key.`);
  }
  return Buffer.from(value, 'hex');
};

const encryptCredentials = credentials => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
};

const decryptCredentials = ciphertext => {
  const packed = Buffer.from(ciphertext, 'base64');
  if (packed.length < 29) throw new Error('Stored carrier credentials are invalid.');
  const iv = packed.subarray(0, 12);
  const authTag = packed.subarray(12, 28);
  const encrypted = packed.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
};

module.exports = { encryptCredentials, decryptCredentials };
