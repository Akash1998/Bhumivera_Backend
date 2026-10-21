require('dotenv').config();

const { StringDecoder } = require('string_decoder');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { SUPERADMIN_EMAIL } = require('../models/superAdminVaultModel');
const { validatePasswordBasic } = require('../utils/passwordPolicy');

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      reject(new Error('Run this command in an interactive terminal so the password can be entered without echo.'));
      return;
    }

    const decoder = new StringDecoder('utf8');
    let value = '';
    let settled = false;
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const finish = (error) => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
      for (const character of decoder.write(chunk)) {
        if (character === '\u0003') {
          finish(new Error('Cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
        } else {
          value += character;
        }
      }
    };

    process.stdin.on('data', onData);
  });
}

async function main() {
  try {
    await pool.query('SELECT 1');
    const [existing] = await pool.query(
      'SELECT id FROM admin_users WHERE email = ? LIMIT 1',
      [SUPERADMIN_EMAIL]
    );
    if (existing.length) {
      throw new Error('The SuperAdmin account already exists; this command will not overwrite its password.');
    }

    const password = await readSecret(`New password for ${SUPERADMIN_EMAIL}: `);
    const confirmation = await readSecret('Confirm new password: ');
    if (password !== confirmation) throw new Error('Passwords do not match.');

    const validation = validatePasswordBasic(password);
    if (!validation.valid) {
      throw new Error(validation.errors.map(({ message }) => message).join(' '));
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO admin_users (email, password_hash, role) VALUES (?, ?, ?)',
      [SUPERADMIN_EMAIL, passwordHash, 'superadmin']
    );
    console.log(`Created the SuperAdmin account for ${SUPERADMIN_EMAIL}.`);
    console.log('Sign in through the admin login page; the first sign-in sends a one-time code to that email.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[SUPERADMIN_SETUP] ${error.message}`);
  process.exitCode = 1;
});
