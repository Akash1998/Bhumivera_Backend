'use strict';

const { GoogleGenAI } = require('@google/genai');

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
    knowledgeBaseResponse: knowledgeResult?.matched ? knowledgeResult.reply : null,
    toolResults: Array.isArray(toolResults) ? toolResults.slice(0, 8) : [],
    recentConversation: recentHistory,
  };

  try {
    const reply = await callGeminiModel({
      prompt:
        'You are Bhumivera Client Concierge. Rephrase the verified response into a clear, concise and warm reply. ' +
        'Use only facts contained in the supplied data. Do not invent product ingredients, product claims, prices, ' +
        'shipping estimates, account/order details, or actions. Do not contradict or omit material safety guidance. ' +
        'If the verified response is empty, return an empty string. Return only the customer-facing reply.\n\n' +
        JSON.stringify(groundedData),
      timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS) || 8000,
    });
    if (reply) return { ...fallback, reply, provider: model };
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
