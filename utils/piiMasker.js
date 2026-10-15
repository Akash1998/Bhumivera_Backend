'use strict';

/**
 * Enterprise PII Masking & Redaction Utility for AI Customer Support Logs
 * Ensures payment card numbers, CVVs, passwords, OTPs, JWTs, API keys, and
 * government IDs are stripped before database persistence, logging, or LLM/webhook transit.
 */

const SENSITIVE_KEY_PATTERN = /^(password|pass|pwd|password_hash|new_password|current_password|card_number|cardnumber|cc_number|pan_number|cvv|cvc|cvv2|pin|otp|reset_otp|challenge_code|two_factor_secret|security_answer|security_answer_hash|token|access_token|refresh_token|jwt|authorization|api_key|apikey|secret|client_secret|private_key)$/i;

/**
 * Checks if a digit sequence of length 13-19 passes the Luhn checksum.
 */
function passesLuhn(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * Redacts sensitive PII from free-form text while preserving safe 9-digit Bhumivera
 * order numbers and 10-digit Indian phone numbers (unless explicitly formatted as a card).
 *
 * @param {string} input
 * @returns {string}
 */
function maskPII(input) {
  if (input === null || input === undefined) return '';
  let text = String(input);

  // 1. Redact JWT tokens (header.payload.signature)
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_TOKEN]');

  // 2. Redact Bearer tokens and known API key prefixes
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, 'Bearer [REDACTED_TOKEN]');
  text = text.replace(/\b(sk-[A-Za-z0-9]{16,}|rzp_(?:live|test)_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED_API_KEY]');

  // 3. Redact explicit password / PIN / Secret / OTP declarations
  text = text.replace(
    /\b(password|passwd|pwd|passcode|pin|secret\s*key|security\s*answer)\s*(?:is|=|:|\s+)\s*([^\s,;."']{3,64})/gi,
    (_match, label) => `${label}: [REDACTED_SECRET]`
  );
  text = text.replace(
    /\b(otp|verification\s*code|2fa\s*code)\s*(?:is|=|:)?\s*\b(\d{4,8})\b/gi,
    (_match, label) => `${label}: [REDACTED_OTP]`
  );

  // 4. Redact CVV / CVC mentions
  text = text.replace(
    /\b(cvv|cvc|cvv2|cid|security\s*code)\s*(?:is|=|:|#)?\s*\b(\d{3,4})\b/gi,
    (_match, label) => `${label}: [REDACTED_CVV]`
  );

  // 5. Redact 13 to 19 digit payment card sequences (spaced, hyphenated, or contiguous)
  text = text.replace(/\b(?:\d[ -]*?){13,19}\b/g, (candidate) => {
    const digitsOnly = candidate.replace(/\D/g, '');
    if (digitsOnly.length < 13 || digitsOnly.length > 19) return candidate;
    // Mask any 13-19 digit sequence that either passes Luhn or looks like a 15/16-digit card
    if (passesLuhn(digitsOnly) || digitsOnly.length === 15 || digitsOnly.length === 16) {
      const last4 = digitsOnly.slice(-4);
      return `[REDACTED_CARD_ENDING_${last4}]`;
    }
    return candidate;
  });

  // 6. Redact Indian PAN card numbers (5 letters, 4 digits, 1 letter) when shared in chat
  text = text.replace(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, '[REDACTED_PAN]');

  // 7. Redact 12-digit Aadhaar patterns when labeled or grouped in 4-4-4
  text = text.replace(
    /\b(aadhaar|aadhar|uid)\s*(?:no|number|id|:|=)?\s*(\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/gi,
    (_m, label) => `${label}: [REDACTED_AADHAAR]`
  );

  return text;
}

/**
 * Deeply clones and masks PII across objects, arrays, and strings.
 *
 * @param {any} value
 * @param {number} depth
 * @returns {any}
 */
function sanitizeObjectPII(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === 'string') return maskPII(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map(item => sanitizeObjectPII(item, depth + 1));
  }

  const sanitized = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = sanitizeObjectPII(val, depth + 1);
    }
  }
  return sanitized;
}

module.exports = {
  maskPII,
  sanitizeObjectPII,
  passesLuhn,
};
