'use strict';

const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const geminiService = require('../services/geminiService');

const originalCallGeminiModel = geminiService.callGeminiModel;
const originalApiKey = process.env.GEMINI_API_KEY;
const originalModel = process.env.GEMINI_MODEL;
let modelResponse;

geminiService.callGeminiModel = async () => {
  if (modelResponse instanceof Error) throw modelResponse;
  return modelResponse;
};

const aiRoutes = require('../routes/aiRoutes');

const invokeRoute = async (path, body) => {
  const layer = aiRoutes.stack.find(candidate => candidate.route?.path === path);
  assert.ok(layer, `Expected route ${path} to be registered`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  await handler({ body }, response);
  return response;
};

after(() => {
  geminiService.callGeminiModel = originalCallGeminiModel;
  if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalApiKey;
  if (originalModel === undefined) delete process.env.GEMINI_MODEL;
  else process.env.GEMINI_MODEL = originalModel;
});

test('product SEO endpoint returns Gemini-generated slug and metadata', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';
  process.env.GEMINI_MODEL = 'gemini-pro-test';
  modelResponse = JSON.stringify({
    slug: 'aloe-vera-face-wash',
    description: 'A face wash made with aloe vera.',
    meta_title: 'Aloe Vera Face Wash | Bhumivera',
    meta_description: 'Explore the Bhumivera aloe vera face wash.',
    tags: 'aloe vera, face wash, cleanser, skincare, Bhumivera',
  });

  const response = await invokeRoute('/generate-product-content', {
    productName: 'Aloe Vera Face Wash',
    specifications: { Ingredient: 'Aloe vera' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.model, 'gemini-pro-test');
  assert.equal(response.body.data.slug, 'aloe-vera-face-wash');
  assert.equal(response.body.data.meta_title, 'Aloe Vera Face Wash | Bhumivera');
});

test('taxonomy SEO endpoint returns validated Gemini fields for every item', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';
  process.env.GEMINI_MODEL = 'gemini-pro-test';
  modelResponse = JSON.stringify({
    items: [{
      id: 'category-1',
      slug: 'facial-cleansers',
      description: 'Explore facial cleansers from Bhumivera.',
      meta_title: 'Facial Cleansers | Bhumivera',
      meta_description: 'Explore facial cleansers for your daily skincare routine.',
    }],
  });

  const response = await invokeRoute('/generate-taxonomy-seo', {
    items: [{ id: 'category-1', type: 'category', name: 'Facial Cleansers' }],
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.model, 'gemini-pro-test');
  assert.equal(response.body.items[0].slug, 'facial-cleansers');
  assert.equal(response.body.items[0].meta_title, 'Facial Cleansers | Bhumivera');
});

test('taxonomy SEO endpoint surfaces a Gemini deadline error without fallback content', async t => {
  process.env.GEMINI_API_KEY = 'test-api-key';
  modelResponse = Object.assign(new Error('Deadline expired'), { status: 504 });
  t.mock.method(console, 'error', () => {});

  const response = await invokeRoute('/generate-taxonomy-seo', {
    items: [{ id: 'category-1', type: 'category', name: 'Facial Cleansers' }],
  });

  assert.equal(response.statusCode, 504);
  assert.equal(response.body.success, false);
  assert.match(response.body.message, /timed out/i);
});
