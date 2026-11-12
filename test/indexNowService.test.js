const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { INDEXNOW_KEY, notifyIndexNow } = require('../services/indexNowService');

describe('IndexNow submissions', () => {
  it('submits deduplicated URLs on the verified www host with the hosted key location', async () => {
    let request;
    const result = await notifyIndexNow([
      'https://www.bhumivera.com/product/example',
      'https://www.bhumivera.com/product/example',
      'https://bhumivera.com/product/not-canonical',
      'not-a-url',
    ], {
      fetchImpl: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return { ok: true, status: 200 };
      },
    });

    assert.equal(result, true);
    assert.equal(request.url, 'https://api.indexnow.org/indexnow');
    assert.equal(request.body.host, 'www.bhumivera.com');
    assert.equal(request.body.key, INDEXNOW_KEY);
    assert.equal(request.body.keyLocation, `https://www.bhumivera.com/${INDEXNOW_KEY}.txt`);
    assert.deepEqual(request.body.urlList, ['https://www.bhumivera.com/product/example']);
  });

  it('reports submission failures without throwing', async () => {
    const errors = [];
    const result = await notifyIndexNow(['https://www.bhumivera.com/'], {
      fetchImpl: async () => ({ ok: false, status: 429 }),
      logger: { error: (...args) => errors.push(args) },
    });

    assert.equal(result, false);
    assert.equal(errors.length, 1);
  });

  it('does not make a request when no canonical URLs are supplied', async () => {
    let requested = false;
    const result = await notifyIndexNow(['https://bhumivera.com/', '/shop'], {
      fetchImpl: async () => { requested = true; return { ok: true, status: 200 }; },
    });

    assert.equal(result, false);
    assert.equal(requested, false);
  });

  it('splits submissions into batches of at most 10,000 URLs', async () => {
    const batchSizes = [];
    const urls = Array.from({ length: 10001 }, (_, index) =>
      `https://www.bhumivera.com/product/${index}`
    );

    const result = await notifyIndexNow(urls, {
      fetchImpl: async (url, options) => {
        batchSizes.push(JSON.parse(options.body).urlList.length);
        return { ok: true, status: 200 };
      },
    });

    assert.equal(result, true);
    assert.deepEqual(batchSizes, [10000, 1]);
  });
});
