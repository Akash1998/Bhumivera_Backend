'use strict';

let GoogleGenAI = null;
try {
  ({ GoogleGenAI } = require('@google/genai'));
} catch (_) {
  GoogleGenAI = null;
}

const DEFAULT_MODEL = 'gemini-2.0-flash';

function resolveGeminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY?.trim() || '';
  return {
    configured: Boolean(apiKey),
    model: process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL,
  };
}

async function callGeminiModel({ prompt, responseMimeType, timeoutMs = 15000 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('AI content generation is not configured. Set GEMINI_API_KEY on the server.');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('A non-empty prompt is required.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: resolveGeminiConfig().model,
    contents: prompt,
    config: {
      ...(responseMimeType ? { responseMimeType } : {}),
      httpOptions: { timeout: Math.max(1000, Number(timeoutMs) || 15000) },
    },
  });
  return typeof response.text === 'string' ? response.text.trim() : '';
}

async function synthesizeWithGeminiOrDeterministic({
  userMessage,
  history = [],
  toolResults = [],
  knowledgeResult = null,
  deterministicFallback = {},
  user = null,
} = {}) {
  const fallback = {
    ...deterministicFallback,
    provider: 'deterministic-verified',
  };
  const { configured, model } = resolveGeminiConfig();
  if (!configured || !fallback.reply) return fallback;

  const recentHistory = Array.isArray(history)
    ? history.slice(-6).map(item => ({
      sender: String(item.sender || '').slice(0, 30),
      content: String(item.content || '').slice(0, 1200),
    }))
    : [];
  const groundedData = {
    userQuestion: String(userMessage || '').slice(0, 2000),
    verifiedDeterministicResponse: fallback.reply,
    suggestedQuickActions: fallback.quickActions || [],
    knowledgeBaseResponse: knowledgeResult?.matched ? knowledgeResult.reply : null,
    toolResults: Array.isArray(toolResults) ? toolResults.slice(0, 8) : [],
    recentConversation: recentHistory,
    userName: user?.name ? user.name.split(' ')[0] : null,
  };

  try {
    const prompt =
      'You are the Bhumivera Client Concierge, an elite, warm, and highly knowledgeable conversational advisor for Bhumivera (Ayurvedic & Modern Botanical Skincare).\n' +
      'Your role is to rephrase the verified deterministic response into a rich, welcoming, elegant, and deeply informed customer-facing response, and generate 3 to 4 forward-progressing follow-up quickAction suggestions.\n\n' +
      'STRICT CONSTRAINTS:\n' +
      '1. Truthfulness: Use only facts contained in the supplied grounded data. Never invent ingredients, claims, order IDs, prices, discounts, or external URLs.\n' +
      '2. Invariant Preservation: If the verified response includes specific safety or timing instructions (e.g., "Best Time to Use", "30 to 45 seconds", order numbers, refund windows, or RMA numbers), you MUST preserve them clearly.\n' +
      '3. Dynamic Forward-Moving Suggestions: Do NOT repeat the question just asked or previously asked in recent conversation. Suggest logical next steps that advance the customer journey (e.g., post-wash layering ritual, botanical active synergy, sensitive skin compatibility, PM pairing with Kumkumadi Night Elixir, order tracking, or Brand Ambassador Program).\n' +
      '4. Persuasive Product Science & Educational Depth: When explaining products or active ingredients, provide a structured, convincing breakdown (5 clear points, ~10 lines) showing how the formula really works on a cellular/barrier level. Highlight authentic benefits, calibrated actives, and physiological pH 5.5. Never tell the customer to "check packaging" or "see label" — provide complete, persuasive answers.\n' +
      '5. Output Format: Return a strictly valid JSON object with the following schema:\n' +
      '{\n' +
      '  "reply": "string (warm, markdown-formatted concierge response)",\n' +
      '  "quickActions": [\n' +
      '    {\n' +
      '      "id": "string",\n' +
      '      "label": "string (concise button label, 2-6 words, optional emoji)",\n' +
      '      "prompt": "string (complete customer question to be sent upon clicking)",\n' +
      '      "category": "string"\n' +
      '    }\n' +
      '  ]\n' +
      '}\n\n' +
      'Grounded Data:\n' +
      JSON.stringify(groundedData);

    const rawResponse = await callGeminiModel({
      prompt,
      responseMimeType: 'application/json',
      timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS) || 8000,
    });

    if (rawResponse) {
      let parsed = null;
      try {
        const cleaned = rawResponse.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = null;
      }

      if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
        const validQuickActions = Array.isArray(parsed.quickActions) && parsed.quickActions.length > 0
          ? parsed.quickActions.filter(a => a && typeof a.label === 'string' && typeof a.prompt === 'string')
          : fallback.quickActions;

        return {
          ...fallback,
          reply: parsed.reply.trim(),
          quickActions: validQuickActions && validQuickActions.length > 0 ? validQuickActions : fallback.quickActions,
          provider: model,
        };
      }

      return { ...fallback, reply: rawResponse, provider: model };
    }
  } catch (error) {
    console.warn('[GEMINI_SYNTHESIS_FALLBACK]', error.message);
  }
  return fallback;
}

module.exports = {
  resolveGeminiConfig,
  callGeminiModel,
  synthesizeWithGeminiOrDeterministic,
};
