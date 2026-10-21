const crypto = require('crypto');
const https = require('https');

const isPwned = async (pw) => {
  try {
    const sha1 = crypto.createHash('sha1').update(String(pw)).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    return await new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.pwnedpasswords.com',
        path: `/range/${prefix}`,
        method: 'GET',
        headers: {
          'User-Agent': 'Bhumivera-Backend',
          'Add-Padding': 'true'
        },
        timeout: 2500
      }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c.toString()));
        res.on('end', () => {
          try {
            const lines = body.split(/\r?\n/);
            let count = 0;
            for (const line of lines) {
              const [s, n] = line.split(':');
              if (s && s.trim() === suffix) { count = parseInt(n || '0', 10); break; }
            }
            resolve({ pwned: count > 0, count, skipped: false });
          } catch (e) {
            console.warn('[HIBP] Parse error:', e.message);
            resolve({ pwned: false, count: 0, skipped: true });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); console.warn('[HIBP] Timed out.'); resolve({ pwned: false, count: 0, skipped: true }); });
      req.on('error', (e) => { console.warn('[HIBP] Skipped password check:', e.message); resolve({ pwned: false, count: 0, skipped: true }); });
      req.end();
    });
  } catch (e) {
    console.warn('[HIBP] Skipped password check:', e.message);
    return { pwned: false, count: 0, skipped: true };
  }
};

const isPwnedSyncUnsafe = () => ({ pwned: false, count: 0, skipped: true });

module.exports = { isPwned, isPwnedSyncUnsafe };
