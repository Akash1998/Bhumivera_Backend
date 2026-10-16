'use strict';

const {
  findRelevantConciergeAnswer,
  getAllConciergeKnowledgeAnswers,
} = require('./conciergeKnowledgeBase');

const INGREDIENT_MEMORY_GRAPH = Object.freeze({
  sea_buckthorn: {
    id: 'sea_buckthorn',
    name: 'Sea Buckthorn',
    aliases: ['seabuckthorn', 'seabuck thorn', 'hippophae rhamnoides', 'omega 7'],
    summary: 'A botanical ingredient containing fatty acids and antioxidant compounds.',
    relatedIngredients: ['niacinamide', 'hyaluronic_acid'],
  },
  niacinamide: {
    id: 'niacinamide',
    name: 'Niacinamide (Vitamin B3)',
    aliases: ['niacidamine', 'vitamin b3', 'nicotinamide'],
    summary: 'A form of vitamin B3 used in skincare formulations.',
    relatedIngredients: ['hyaluronic_acid', 'glycerin'],
  },
  hyaluronic_acid: {
    id: 'hyaluronic_acid',
    name: 'Hyaluronic Acid',
    aliases: ['hyaluron', 'sodium hyaluronate'],
    summary: 'A humectant used in skincare formulations.',
    relatedIngredients: ['glycerin', 'niacinamide'],
  },
  aloe_vera: {
    id: 'aloe_vera',
    name: 'Aloe Vera',
    aliases: ['aloe'],
    summary: 'A botanical ingredient used in some skincare formulations.',
    relatedIngredients: ['glycerin', 'sea_buckthorn'],
  },
  glycerin: {
    id: 'glycerin',
    name: 'Glycerin',
    aliases: ['glycerine'],
    summary: 'A humectant used in skincare formulations.',
    relatedIngredients: ['hyaluronic_acid', 'niacinamide'],
  },
  tulsi: {
    id: 'tulsi',
    name: 'Tulsi (Holy Basil)',
    aliases: ['holy basil', 'ocimum tenuiflorum'],
    summary: 'A botanical ingredient used in some skincare formulations.',
    relatedIngredients: ['sea_buckthorn', 'aloe_vera'],
  },
  activated_charcoal: {
    id: 'activated_charcoal',
    name: 'Activated Charcoal',
    aliases: ['charcoal'],
    summary: 'An adsorbent used in some cleansing products.',
    relatedIngredients: ['glycerin', 'neem'],
  },
  neem: {
    id: 'neem',
    name: 'Neem',
    aliases: ['azadirachta'],
    summary: 'A botanical ingredient used in some skincare formulations.',
    relatedIngredients: ['haridra', 'activated_charcoal'],
  },
  haridra: {
    id: 'haridra',
    name: 'Haridra (Turmeric)',
    aliases: ['turmeric', 'curcuma longa'],
    summary: 'A botanical ingredient used in some skincare formulations.',
    relatedIngredients: ['neem', 'activated_charcoal'],
  },
});

const PRODUCT_INGREDIENT_GRAPH = Object.freeze({
  sea_buckthorn_face_wash: {
    id: 'sea_buckthorn_face_wash',
    name: 'Bhumivera Sea Buckthorn Face Wash',
    aliases: ['sea buckthorn face wash', 'seabuckthorn face wash', 'seabuck thorn face wash'],
    keyActives: [
      { id: 'sea_buckthorn', name: 'Sea Buckthorn', concentration: 'See product label' },
      { id: 'niacinamide', name: 'Niacinamide (Vitamin B3)', concentration: 'See product label' },
      { id: 'hyaluronic_acid', name: 'Hyaluronic Acid', concentration: 'See product label' },
      { id: 'aloe_vera', name: 'Aloe Vera', concentration: 'See product label' },
      { id: 'glycerin', name: 'Glycerin', concentration: 'See product label' },
      { id: 'tulsi', name: 'Tulsi', concentration: 'See product label' },
    ],
    usage: 'Massage gently on wet skin for 30 to 45 seconds, rinse thoroughly, and follow the directions on the product label.',
  },
  charcoal_face_wash: {
    id: 'charcoal_face_wash',
    name: 'Bhumivera Charcoal Face Wash',
    aliases: ['charcoal face wash', 'activated charcoal face wash'],
    keyActives: [
      { id: 'activated_charcoal', name: 'Activated Charcoal', concentration: 'See product label' },
      { id: 'glycerin', name: 'Glycerin', concentration: 'See product label' },
      { id: 'neem', name: 'Neem', concentration: 'See product label' },
      { id: 'haridra', name: 'Haridra (Turmeric)', concentration: 'See product label' },
      { id: 'hyaluronic_acid', name: 'Hyaluronic Acid', concentration: 'See product label' },
      { id: 'niacinamide', name: 'Niacinamide', concentration: 'See product label' },
    ],
    usage: 'Massage gently on wet skin for 30 to 45 seconds, rinse thoroughly, and follow the directions on the product label.',
  },
  botanical_shampoo: {
    id: 'botanical_shampoo',
    name: 'Bhumivera Botanical Shampoo',
    aliases: ['botanical shampoo', 'haircare shampoo'],
    keyActives: [
      { id: 'amla', name: 'Amla', concentration: 'See product label' },
      { id: 'reetha', name: 'Reetha', concentration: 'See product label' },
      { id: 'shikakai', name: 'Shikakai', concentration: 'See product label' },
      { id: 'bhringraj', name: 'Bhringraj', concentration: 'See product label' },
      { id: 'rosemary', name: 'Rosemary', concentration: 'See product label' },
      { id: 'neem', name: 'Neem', concentration: 'See product label' },
    ],
    usage: 'Follow the directions and complete ingredient list on the product label.',
  },
});

const qaCategories = [
  { through: 35, category: 'sea_buckthorn' },
  { through: 65, category: 'haircare' },
  { through: 95, category: 'charcoal_cleanser' },
  { through: 125, category: 'usage' },
  { through: 155, category: 'precautions' },
  { through: 180, category: 'ingredient_synergy' },
  { through: 200, category: 'brand_quality' },
];

const KNOWLEDGE_BASE_QA = Object.freeze(
  getAllConciergeKnowledgeAnswers().map(entry => ({
    ...entry,
    category: qaCategories.find(range => entry.number <= range.through)?.category || 'general',
  }))
);

const QUICK_ACTIONS = Object.freeze([
  {
    id: 'know_sb_fw',
    label: 'Know More: Sea Buckthorn Face Wash',
    prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients',
    category: 'product_discovery',
  },
  {
    id: 'ing_niacinamide',
    label: 'Ingredient: Niacinamide',
    prompt: 'Tell me about Niacinamide in Sea Buckthorn Face Wash',
    category: 'ingredient_discovery',
  },
  {
    id: 'usage_time',
    label: 'How & What Time to Use Face Wash',
    prompt: 'How do I use face wash, and what time of day should I use it?',
    category: 'usage_and_timing',
  },
  {
    id: 'amb_join',
    label: 'Brand Ambassador Program',
    prompt: 'How do I join the Bhumivera Brand Ambassador Program?',
    category: 'ambassador',
  },
]);

const normalize = value => String(value || '')
  .toLowerCase()
  .replace(/seabuck\s*thorn/g, 'sea buckthorn')
  .replace(/seabuckthorn/g, 'sea buckthorn')
  .replace(/niacidamine/g, 'niacinamide')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

function findByAliases(query, collection) {
  const normalizedQuery = normalize(query);
  return Object.values(collection).find(item =>
    [item.name, ...(item.aliases || [])].some(alias => {
      const normalizedAlias = normalize(alias);
      return normalizedAlias && normalizedQuery.includes(normalizedAlias);
    })
  ) || null;
}

function buildIngredientFollowUpSuggestions(ingredient, product = null) {
  const entry = typeof ingredient === 'string'
    ? INGREDIENT_MEMORY_GRAPH[ingredient] || findByAliases(ingredient, INGREDIENT_MEMORY_GRAPH)
    : ingredient;
  if (!entry) return [];

  const productName = product?.name || PRODUCT_INGREDIENT_GRAPH[product]?.name || 'Sea Buckthorn Face Wash';
  const related = (entry.relatedIngredients || [])
    .map(id => INGREDIENT_MEMORY_GRAPH[id])
    .filter(Boolean);
  const relatedIngredient = related[0] || INGREDIENT_MEMORY_GRAPH.hyaluronic_acid;
  return [
    {
      id: `${entry.id}_deep_dive_1`,
      label: `${entry.name}: What It Is`,
      prompt: `What is ${entry.name} and how is it used in skincare?`,
      category: 'ingredient_deep_dive',
    },
    {
      id: `${entry.id}_deep_dive_2`,
      label: `${entry.name}: Product Use & Pairing`,
      prompt: `How should I use ${entry.name} and what ingredients can be paired with it?`,
      category: 'ingredient_deep_dive',
    },
    {
      id: `related_${relatedIngredient.id}`,
      label: `Related Ingredient: ${relatedIngredient.name}`,
      prompt: `Tell me about ${relatedIngredient.name}`,
      category: 'closely_related_ingredient',
    },
    {
      id: 'usage_time',
      label: `How & What Time to Use ${productName.replace(/^Bhumivera\s+/i, '')}`,
      prompt: `How do I use ${productName} and what time of day should I use it?`,
      category: 'usage_and_timing',
    },
  ];
}

function buildProductIngredientSuggestions(product) {
  const entry = typeof product === 'string'
    ? PRODUCT_INGREDIENT_GRAPH[product] || findByAliases(product, PRODUCT_INGREDIENT_GRAPH)
    : product;
  if (!entry) return QUICK_ACTIONS.slice(0, 3);

  const firstIngredient = entry.keyActives[0];
  const nextIngredient = entry.keyActives.find(item => item.id === 'niacinamide') || entry.keyActives[1];
  return [
    {
      id: `know_${entry.id}`,
      label: `Know More: ${entry.name.replace(/^Bhumivera\s+/i, '')}`,
      prompt: `Tell me about ${entry.name} and its key ingredients`,
      category: 'product_discovery',
    },
    ...[firstIngredient, nextIngredient].filter(Boolean).map(item => ({
      id: `ingredient_${item.id}`,
      label: `Ingredient: ${item.name}`,
      prompt: `Tell me about ${item.name} in ${entry.name}`,
      category: 'ingredient_discovery',
    })),
    {
      id: 'usage_time',
      label: `How & What Time to Use ${entry.name.replace(/^Bhumivera\s+/i, '')}`,
      prompt: `How do I use ${entry.name} and what time of day should I use it?`,
      category: 'usage_and_timing',
    },
  ];
}

async function searchAllKnowledgeSources(message, options = {}, suppliedPool = null) {
  const context = options && typeof options === 'object' ? options : {};
  const sessionContext = context.sessionContext || context;
  const normalizedQuery = normalize(message);
  const product = findByAliases(message, PRODUCT_INGREDIENT_GRAPH);
  const ingredient = findByAliases(message, INGREDIENT_MEMORY_GRAPH);
  const ingredientOnlyInProductName = product && ingredient && product.aliases.some(productAlias =>
    [ingredient.name, ...(ingredient.aliases || [])].some(alias => {
      const normalizedAlias = normalize(alias);
      return normalizedAlias.length > 3 &&
        normalize(productAlias).includes(normalizedAlias) &&
        normalizedQuery.includes(normalizedAlias);
    })
  );

  if (/\b(ambassador|affiliate|referral program)\b/.test(normalizedQuery)) {
    return {
      matched: true,
      matchedType: 'ambassador',
      reply: 'To join the **Bhumivera Brand Ambassador Program**, sign in at https://www.bhumivera.com/profile and open the **Brand Ambassador Program** section, or visit https://www.bhumivera.com/affiliate.',
      quickActions: QUICK_ACTIONS.slice(0, 3),
      updatedContext: {},
      flowType: 'ambassador',
    };
  }

  if (/\b(when|what time|how often|how long|routine|use|usage|apply|application)\b/.test(normalizedQuery) && product) {
    return {
      matched: true,
      matchedType: 'usage',
      reply: `**Best Time to Use ${product.name}:** Follow the product label for frequency and directions. For face wash, gently massage on wet skin for **30 to 45 seconds**, then rinse thoroughly. Avoid the eye area.`,
      quickActions: buildProductIngredientSuggestions(product),
      updatedContext: { activeProductId: product.id, lastIngredientId: sessionContext.lastIngredientId || null },
      flowType: 'usage_guide',
      activeProductId: product.id,
      lastIngredientId: sessionContext.lastIngredientId || null,
    };
  }

  if (ingredient && !ingredientOnlyInProductName) {
    const activeProduct = PRODUCT_INGREDIENT_GRAPH[sessionContext.activeProductId] || product;
    const isListedInProduct = activeProduct?.keyActives.some(active => active.id === ingredient.id);
    const productNote = activeProduct
      ? isListedInProduct
        ? ` It is listed in the ${activeProduct.name}; check the package for the full ingredient list and exact concentration.`
        : ` Check the ${activeProduct.name} package to confirm whether it is included.`
      : ' Ingredient inclusion and concentration vary by product; check the package label.';
    return {
      matched: true,
      matchedType: 'ingredient',
      reply: `**${ingredient.name}:** ${ingredient.summary}${productNote}`,
      quickActions: buildIngredientFollowUpSuggestions(ingredient, activeProduct),
      updatedContext: {
        activeProductId: activeProduct?.id || null,
        lastIngredientId: ingredient.id,
      },
      flowType: 'ingredient_deep_dive',
      activeProductId: activeProduct?.id || null,
      lastIngredientId: ingredient.id,
    };
  }

  if (product) {
    const listedIngredients = product.keyActives.map(active => `**${active.name}**`).join(', ');
    return {
      matched: true,
      matchedType: 'product',
      reply: `**${product.name}**\n\n**Complete Listed Ingredients Checked in Memory:** ${listedIngredients}.\n\nFor the complete ingredient list, exact concentrations, and current directions, check the product packaging.`,
      quickActions: buildProductIngredientSuggestions(product),
      updatedContext: { activeProductId: product.id, lastIngredientId: null },
      flowType: 'product_discovery',
      activeProductId: product.id,
      lastIngredientId: null,
    };
  }

  const archiveMatch = findRelevantConciergeAnswer(message);
  if (archiveMatch) {
    return {
      matched: true,
      matchedType: 'knowledge_base_qa',
      reply: archiveMatch.answer,
      quickActions: QUICK_ACTIONS.slice(0, 3),
      updatedContext: {
        activeProductId: sessionContext.activeProductId || null,
        lastIngredientId: sessionContext.lastIngredientId || null,
      },
      flowType: 'knowledge_base_qa',
    };
  }

  return {
    matched: false,
    matchedType: null,
    reply: '',
    quickActions: [],
    updatedContext: {},
    flowType: null,
  };
}

module.exports = {
  INGREDIENT_MEMORY_GRAPH,
  PRODUCT_INGREDIENT_GRAPH,
  KNOWLEDGE_BASE_QA,
  searchAllKnowledgeSources,
  buildIngredientFollowUpSuggestions,
  buildProductIngredientSuggestions,
};
