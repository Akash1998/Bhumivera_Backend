const INDEXNOW_KEY = 'b4b0ecccd2749abb58822fa6846f5d923a61a7d30242c52d';
const SITE_HOST = 'www.bhumivera.com';
const SITE_ORIGIN = `https://${SITE_HOST}`;
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

async function notifyIndexNow(urls, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  const validUrls = [...new Set((Array.isArray(urls) ? urls : [])
    .filter(url => typeof url === 'string')
    .map(value => {
      try {
        const url = new URL(value);
        return url.origin === SITE_ORIGIN ? url.href : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean))];

  if (!validUrls.length) return false;
  if (typeof fetchImpl !== 'function') {
    logger.error('[INDEXNOW_SUBMIT_FAILED] Fetch is unavailable.');
    return false;
  }

  for (let offset = 0; offset < validUrls.length; offset += 10000) {
    const urlList = validUrls.slice(offset, offset + 10000);
    try {
      const response = await fetchImpl(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host: SITE_HOST,
          key: INDEXNOW_KEY,
          keyLocation: `${SITE_ORIGIN}/${INDEXNOW_KEY}.txt`,
          urlList,
        }),
        signal: AbortSignal.timeout(4000),
      });

      if (!response.ok) {
        logger.error(`[INDEXNOW_SUBMIT_FAILED] IndexNow returned HTTP ${response.status} for a batch of ${urlList.length} URL(s).`);
        return false;
      }
    } catch (error) {
      logger.error('[INDEXNOW_SUBMIT_FAILED]', error);
      return false;
    }
  }

  return true;
}

module.exports = { INDEXNOW_KEY, notifyIndexNow };
