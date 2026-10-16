'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  KNOWLEDGE_BASE_QA,
  searchAllKnowledgeSources,
} = require('../services/bhumiveraKnowledgeBase');
const {
  synthesizeWithGeminiOrDeterministic,
} = require('../services/geminiService');

test('knowledge archive loads and exposes the complete Q&A set', () => {
  assert.equal(KNOWLEDGE_BASE_QA.length, 200);
  assert.ok(KNOWLEDGE_BASE_QA.every(item => item.question && item.answer && item.category));
});

test('product questions return ingredient suggestions and persist product flow context', async () => {
  const result = await searchAllKnowledgeSources('Know more about seabuck thorn face wash');

  assert.equal(result.matched, true);
  assert.match(result.reply, /Complete Listed Ingredients Checked in Memory/);
  assert.ok(result.quickActions.some(action => /Niacinamide/i.test(action.label)));
  assert.equal(result.updatedContext.activeProductId, 'sea_buckthorn_face_wash');
});

test('ingredient questions return two deep dives, one related ingredient, and usage guidance', async () => {
  const result = await searchAllKnowledgeSources('niacidamine', {
    activeProductId: 'sea_buckthorn_face_wash',
  });

  assert.equal(result.matched, true);
  assert.match(result.reply, /Niacinamide/i);
  assert.equal(result.quickActions.filter(action => action.category === 'ingredient_deep_dive').length, 2);
  assert.equal(result.quickActions.filter(action => action.category === 'closely_related_ingredient').length, 1);
  assert.equal(result.quickActions.filter(action => action.category === 'usage_and_timing').length, 1);
});

test('usage questions return product-specific timing guidance', async () => {
  const result = await searchAllKnowledgeSources(
    'How do I really use Sea Buckthorn Face Wash and what time of day should I use it?'
  );

  assert.equal(result.matchedType, 'usage');
  assert.match(result.reply, /Best Time to Use/);
  assert.match(result.reply, /30 to 45 seconds/);
});

test('Gemini synthesis preserves the deterministic response when not configured', async t => {
  const previousApiKey = process.env.GEMINI_API_KEY;
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousApiKey;
  });
  delete process.env.GEMINI_API_KEY;

  const result = await synthesizeWithGeminiOrDeterministic({
    userMessage: 'Question',
    deterministicFallback: { reply: 'Verified response', quickActions: [{ id: 'next' }] },
  });

  assert.equal(result.reply, 'Verified response');
  assert.deepEqual(result.quickActions, [{ id: 'next' }]);
  assert.equal(result.provider, 'deterministic-verified');
});
