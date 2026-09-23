const { isCommonPassword } = require('./commonPasswords');

const SCORE_MIN_RUBRIC = { WEAK: 0, FAIR: 1, OK: 2, GOOD: 3, STRONG: 4 };

const getPasswordScore04 = (pw) => {
  const s = String(pw || '');
  let score = 0;
  if (s.length >= 12) score++;
  if (s.length >= 16) score++;
  if (/[A-Z]/.test(s)) score++;
  if (/[0-9]/.test(s)) score++;
  if (/[^A-Za-z0-9]/.test(s)) score++;
  if (score < 0) score = 0;
  if (score > 4) score = 4;
  return score;
};

const classCount = (pw) => {
  const s = String(pw || '');
  return [
    /[A-Z]/.test(s),
    /[a-z]/.test(s),
    /[0-9]/.test(s),
    /[^A-Za-z0-9]/.test(s)
  ].filter(Boolean).length;
};

const validatePasswordBasic = (pw, opts = {}) => {
  const errors = [];
  const s = String(pw || '');
  if (s.length < 12) errors.push({ code:'MIN_LENGTH', message:'Password must be at least 12 characters long.' });
  if (s.length > 128) errors.push({ code:'MAX_LENGTH', message:'Password too long (max 128 characters).' });
  if (classCount(s) < 3) errors.push({ code:'COMPLEXITY', message:'Password must contain at least 3 of: uppercase, lowercase, digit, symbol.' });
  if (isCommonPassword(s)) errors.push({ code:'COMMON_PASSWORD', message:'This password is too commonly used. Choose something more unique.' });
  if (s.toLowerCase().includes('@')) errors.push({ code:'EMAIL_IN_PASSWORD', message:'Avoid using your email address in the password.' });
  const fatal = new Set(['MIN_LENGTH','MAX_LENGTH','COMPLEXITY','COMMON_PASSWORD']);
  const valid = !errors.some(e => fatal.has(e.code));
  return { valid, errors, score: getPasswordScore04(s) };
};

const validatePassword = async (pw, opts = { runHibp: false }) => {
  const result = validatePasswordBasic(pw);
  if (opts.runHibp) {
    try {
      const hibp = require('./hibp');
      const hp = await hibp.isPwned(pw);
      if (hp && hp.pwned && !hp.skipped) {
        result.errors.push({
          code: 'PWNED_PASSWORD',
          message: `This password has appeared in ${hp.count} public data breach(es). Choose a different one.`,
          details: { count: hp.count, skipped: hp.skipped }
        });
        result.valid = false;
      } else if (hp && hp.skipped) {
        result.errors.push({
          code: 'PWNED_CHECK_SKIPPED',
          message: 'Breach check unavailable (offline). Password still validated against local common list.',
          details: { count: 0, skipped: true }
        });
      }
    } catch (e) {
      result.errors.push({ code:'PWNED_CHECK_SKIPPED', message:'Breach check skipped.', details:{skipped:true, error:e.message} });
    }
  }
  return result;
};

module.exports = {
  SCORE_MIN_RUBRIC,
  getPasswordScore04,
  validatePasswordBasic,
  validatePassword
};
