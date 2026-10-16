'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ARCHIVE_PATH = path.join(__dirname, 'conciergeKnowledgeArchive.txt');
const ARCHIVE_TEXT = fs.readFileSync(ARCHIVE_PATH, 'utf8');
const questionMarkers = [...ARCHIVE_TEXT.matchAll(/Q(\d{1,3}):\s*/g)];

const knowledgeEntries = questionMarkers.map((marker, index) => {
  const start = marker.index + marker[0].length;
  const end = questionMarkers[index + 1]?.index ?? ARCHIVE_TEXT.length;
  const section = ARCHIVE_TEXT.slice(start, end).replace(/\s*Module \d+:.*$/s, '').trim();
  const answerSeparator = section.indexOf('A:');

  if (answerSeparator === -1) {
    throw new Error(`Concierge knowledge archive entry Q${marker[1]} has no answer.`);
  }

  return {
    number: Number(marker[1]),
    question: section.slice(0, answerSeparator).trim(),
    answer: section.slice(answerSeparator + 2).trim(),
  };
});

if (
  knowledgeEntries.length !== 200 ||
  knowledgeEntries.some((entry, index) => entry.number !== index + 1 || !entry.question || !entry.answer)
) {
  throw new Error(`Expected 200 sequential concierge Q&A entries; found ${knowledgeEntries.length}.`);
}

const STOP_WORDS = new Set([
  'a', 'about', 'and', 'are', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is',
  'it', 'me', 'my', 'of', 'on', 'or', 'the', 'this', 'to', 'use', 'what', 'when', 'which',
  'why', 'will', 'with', 'you', 'your',
]);

function termsFor(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map(term => {
      if (term.endsWith('ies') && term.length > 4) return `${term.slice(0, -3)}y`;
      if (term.endsWith('ing') && term.length > 5) return term.slice(0, -3);
      if (term.endsWith('ed') && term.length > 4) return term.slice(0, -2);
      if (term.endsWith('s') && term.length > 4) return term.slice(0, -1);
      return term;
    })
    .filter(term => term.length > 2 && !STOP_WORDS.has(term));
}

function findRelevantConciergeAnswer(message) {
  const query = String(message || '').toLowerCase();
  const queryTerms = new Set(termsFor(query));
  if (!queryTerms.size) return null;

  if (/\bface\s*wash\b|\bface\s*cleanser\b/.test(query)) {
    queryTerms.add('cleanser');
    queryTerms.add('charcoal');
  }

  const matched = knowledgeEntries
    .map(entry => {
      const entryTerms = new Set(termsFor(entry.question));
      const overlap = [...queryTerms].filter(term => entryTerms.has(term)).length;
      return { ...entry, overlap, score: overlap / Math.sqrt(queryTerms.size * entryTerms.size) };
    })
    .sort((left, right) => right.score - left.score || right.overlap - left.overlap || left.number - right.number)[0];

  const recognizedProductOrIngredient =
    /\b(sea\s*buckthorn|omega[\s-]*[3679]|shampoo|face\s*wash|face\s*cleanser|charcoal|reetha|shikakai|bhringraj|rosemary|neem|amla|triphala|glycerin|hyaluronic|manjistha|haridra|turmeric|aloe\s*vera|cucumber|niacinamide|sea\s*buckthorn)\b/i.test(query);

  if (!matched || matched.overlap < 2 && !recognizedProductOrIngredient) return null;
  return matched;
}

function getConciergeKnowledgeAnswer(number) {
  return knowledgeEntries.find(entry => entry.number === Number(number)) || null;
}

module.exports = {
  findRelevantConciergeAnswer,
  getConciergeKnowledgeAnswer,
};
