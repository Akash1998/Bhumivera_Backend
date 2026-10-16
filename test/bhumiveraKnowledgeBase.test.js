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

test('usage query returns forward-progressing suggestions without repeating the usage prompt', async () => {
  const usageResult = await searchAllKnowledgeSources(
    'How do I use Sea Buckthorn Face Wash and what time of day should I use it?'
  );

  assert.equal(usageResult.matchedType, 'usage');
  assert.match(usageResult.reply, /Morning \(AM\) Ritual/i);
  assert.match(usageResult.reply, /Evening \(PM\) Ritual/i);
  assert.match(usageResult.reply, /30 to 45 seconds/i);

  // Suggestions must NOT repeat the usage question just asked
  assert.ok(!usageResult.quickActions.some(a => a.category === 'usage_and_timing'), 'Must not loop back to usage suggestion');
  assert.ok(usageResult.quickActions.some(a => a.category === 'post_wash_routine'));
  assert.ok(usageResult.quickActions.some(a => a.category === 'ingredient_synergy'));
  assert.ok(usageResult.quickActions.some(a => a.category === 'skin_compatibility'));
  assert.ok(usageResult.quickActions.some(a => a.category === 'product_pairing'));

  // Test clicking through to post-wash layering
  const layeringResult = await searchAllKnowledgeSources(
    'What skincare products should I apply right after using Sea Buckthorn Face Wash?',
    { activeProductId: 'sea_buckthorn_face_wash' }
  );
  assert.equal(layeringResult.matchedType, 'post_wash_layering');
  assert.match(layeringResult.reply, /60-Second Rule/i);
  assert.match(layeringResult.reply, /Kumkumadi Night Elixir/i);

  // Test clicking through to synergy
  const synergyResult = await searchAllKnowledgeSources(
    'How do Sea Buckthorn and Niacinamide work together in Sea Buckthorn Face Wash?'
  );
  assert.equal(synergyResult.matchedType, 'ingredient_synergy');
  assert.match(synergyResult.reply, /Omega-7/i);
  assert.match(synergyResult.reply, /ceramide/i);

  // Test clicking through to sensitive skin
  const skinResult = await searchAllKnowledgeSources(
    'Is Sea Buckthorn Face Wash safe for sensitive or acne-prone skin, and how do I patch test?'
  );
  assert.equal(skinResult.matchedType, 'skin_compatibility');
  assert.match(skinResult.reply, /pH 5\.5/i);
  assert.match(skinResult.reply, /24-Hour Patch Test/i);

  // Test clicking through to Kumkumadi pairing
  const pairingResult = await searchAllKnowledgeSources(
    'How do I pair Sea Buckthorn Face Wash with Bhumivera Kumkumadi Night Elixir?'
  );
  assert.equal(pairingResult.matchedType, 'product_pairing');
  assert.match(pairingResult.reply, /Golden PM Ritual/i);
});
