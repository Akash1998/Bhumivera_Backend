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
    summary: 'A nutrient-dense botanical super-berry (Hippophae rhamnoides L.) harvested from high-altitude Himalayan valleys. It is uniquely rich in rare Omega-7 (palmitoleic acid), Omegas 3, 6 & 9, and carries up to 12 times more Vitamin C than oranges. In skincare, it fortifies the cellular lipid barrier, neutralizes oxidative stress, and imparts a natural golden radiance.',
    relatedIngredients: ['niacinamide', 'hyaluronic_acid'],
  },
  niacinamide: {
    id: 'niacinamide',
    name: 'Niacinamide (Vitamin B3)',
    aliases: ['niacidamine', 'vitamin b3', 'nicotinamide'],
    summary: 'A physiologically active form of Vitamin B3 calibrated at 1% concentration in Bhumivera face wash formulations. It stimulates natural epidermal ceramide synthesis, visibly refines enlarged pores, regulates excess sebum production, and evens out post-blemish redness and hyperpigmentation without irritating the skin barrier.',
    relatedIngredients: ['hyaluronic_acid', 'glycerin'],
  },
  hyaluronic_acid: {
    id: 'hyaluronic_acid',
    name: 'Hyaluronic Acid',
    aliases: ['hyaluron', 'sodium hyaluronate'],
    summary: 'A high-purity biomimetic humectant (Sodium Hyaluronate) calibrated at 0.5% concentration. It possesses the exceptional ability to bind up to 1,000 times its molecular weight in atmospheric water, infusing multi-depth epidermal hydration and preventing tight, dehydrated sensations after cleansing.',
    relatedIngredients: ['glycerin', 'niacinamide'],
  },
  aloe_vera: {
    id: 'aloe_vera',
    name: 'Aloe Vera',
    aliases: ['aloe', 'aloe barbadensis'],
    summary: 'Cold-pressed botanical juice calibrated at 5% concentration. Rich in polysaccharides, acemannan, and skin-replenishing minerals, it actively cools redness, reduces inflammation, and cushions delicate facial tissue during the cleansing process.',
    relatedIngredients: ['glycerin', 'sea_buckthorn'],
  },
  glycerin: {
    id: 'glycerin',
    name: 'Glycerin',
    aliases: ['glycerine', 'botanical glycerin'],
    summary: '100% plant-derived botanical glycerin calibrated at 4% concentration. Functions as a core moisture-locking humectant that prevents transepidermal water loss (TEWL) and maintains cellular suppleness and elasticity.',
    relatedIngredients: ['hyaluronic_acid', 'niacinamide'],
  },
  tulsi: {
    id: 'tulsi',
    name: 'Tulsi (Holy Basil)',
    aliases: ['holy basil', 'ocimum tenuiflorum', 'ocimum sanctum'],
    summary: 'Classical Ayurvedic Queen of Herbs (Ocimum sanctum). An adaptogenic botanical carrying documented antimicrobial, antioxidant, and skin-clarifying eugenol compounds that defend the skin microbiome against environmental pollution and stress.',
    relatedIngredients: ['sea_buckthorn', 'aloe_vera'],
  },
  activated_charcoal: {
    id: 'activated_charcoal',
    name: 'Activated Charcoal',
    aliases: ['charcoal', 'bamboo charcoal'],
    summary: 'Steam-activated microporous bamboo carbon calibrated at 3% concentration. Acts as a high-surface-area adsorbent that draws out micro-particulate environmental pollutants, excess surface sebum, and deeply congested impurities from pores without mechanical abrasion.',
    relatedIngredients: ['glycerin', 'neem'],
  },
  neem: {
    id: 'neem',
    name: 'Neem',
    aliases: ['azadirachta', 'azadirachta indica', 'nimba'],
    summary: 'Sacred Ayurvedic Nimba (Azadirachta indica leaf extract) calibrated at 0.5% concentration. Rich in margosic acids, nimbidin, and azadirachtin that clarify blemish-prone skin, soothe irritation, and curb bacterial colonization.',
    relatedIngredients: ['haridra', 'activated_charcoal'],
  },
  haridra: {
    id: 'haridra',
    name: 'Haridra (Turmeric)',
    aliases: ['turmeric', 'curcuma longa', 'haldi'],
    summary: 'High-potency standardized Ayurvedic Turmeric (Curcuma longa) rhizome extract calibrated at 0.5% concentration. Standardized for antioxidant curcuminoids, it visibly brightens hyperpigmentation, protects against photo-oxidative stress, and imparts warmth and clarity to the complexion.',
    relatedIngredients: ['neem', 'activated_charcoal'],
  },
  cucumber: {
    id: 'cucumber',
    name: 'Cucumber Extract',
    aliases: ['cucumber', 'cucumis sativus', 'kheera'],
    summary: 'Cold-processed botanical extract calibrated at 0.5% concentration. Rich in polysaccharides, caffeic acid, and natural silica, it immediately cools cutaneous microcirculation, calms irritation, contracts distended capillaries, and relieves facial puffiness and redness.',
    relatedIngredients: ['aloe_vera', 'glycerin'],
  },
  manjistha: {
    id: 'manjistha',
    name: 'Manjistha (Indian Madder)',
    aliases: ['manjishta', 'rubia cordifolia', 'indian madder'],
    summary: 'Revered Ayurvedic blood-purifying root extract calibrated at 0.5% concentration. Rich in bioavailable anthraquinones that inhibit tyrosinase activity, accelerating epidermal turnover to clarify hyperpigmentation, fade post-acne blemishes, and even out dull skin tone.',
    relatedIngredients: ['haridra', 'neem'],
  },
  rosemary: {
    id: 'rosemary',
    name: 'Rosemary Oil',
    aliases: ['rosemary oil', 'rosmarinus officinalis', 'rosemary'],
    summary: 'Pure therapeutic botanical oil calibrated at 10mg per unit. Contains carnosic acid and 1,8-cineole that stimulate scalp microcapillary perfusion, delivering oxygen and vital bio-nutrients directly to hair follicles to match mild topical minoxidil efficacy in follicle revitalization without scalp itching.',
    relatedIngredients: ['bhringraj', 'amla'],
  },
  bhringraj: {
    id: 'bhringraj',
    name: 'Bhringraj (False Daisy)',
    aliases: ['eclipta alba', 'keshraj', 'eclipta prostrata', 'bhringraj'],
    summary: 'Classical Ayurvedic King of Hair (Eclipta alba calibrated at 10mg). Rich in wedelolactone and ecliptine that encourage dormant hair follicles to transition from the resting (telogen) phase back into active growth (anagen), reducing shedding and increasing hair density.',
    relatedIngredients: ['amla', 'rosemary'],
  },
  amla: {
    id: 'amla',
    name: 'Amla (Indian Gooseberry)',
    aliases: ['phyllanthus emblica', 'amalaki', 'indian gooseberry', 'amla'],
    summary: 'Potent Ayurvedic rasayana (Phyllanthus emblica calibrated at 20mg). Delivers concentrated bioavailable Vitamin C and heat-stable tannins that fortify follicular roots, stabilize hair keratin protein fibers, and defend melanocytes from premature greying.',
    relatedIngredients: ['triphala', 'bhringraj'],
  },
  shikakai: {
    id: 'shikakai',
    name: 'Shikakai',
    aliases: ['acacia concinna', 'fruit for hair', 'shikakai'],
    summary: 'Traditional botanical fruit extract (Acacia concinna calibrated at 5mg). Possesses a naturally low acidic pH and soothing plant mucilage that smooths down the hair cuticle, detangles unruly fibers, and imparts high-gloss shine without synthetic conditioners.',
    relatedIngredients: ['reetha', 'amla'],
  },
  reetha: {
    id: 'reetha',
    name: 'Reetha (Soapnut)',
    aliases: ['sapindus mukorossi', 'soapnut', 'reetha'],
    summary: 'Natural saponin-rich botanical (Sapindus mukorossi calibrated at 25mg). Functions as a mild, non-ionic natural cleanser that emulsifies scalp sebum and clears environmental residue without disrupting the scalp’s acidic protective barrier or stripping moisture.',
    relatedIngredients: ['shikakai', 'triphala'],
  },
  triphala: {
    id: 'triphala',
    name: 'Triphala',
    aliases: ['amla haritaki bibhitaki', 'three fruits', 'triphala'],
    summary: 'Synergistic trinity of Amla, Haritaki, and Bibhitaki calibrated at 10mg. Rich in chebulinic acid and gallic acid, it inhibits 5-alpha reductase activity, clarifies hard-water buildup and follicular congestion, and soothes scalp irritation.',
    relatedIngredients: ['amla', 'neem'],
  },
  kumkumadi: {
    id: 'kumkumadi',
    name: 'Kumkumadi Tailam (Night Elixir)',
    aliases: ['kumkumadi', 'kumkumadi tailam', 'kumkumadi oil', 'night elixir'],
    summary: 'Classical 26-herb Ayurvedic formulation infused with authentic Kashmiri Saffron (Kesar), Red Sandalwood (Rakta Chandana), and herbal decoctions. Formulated to be pressed onto clean, damp skin at night to restore cellular moisture, fade dark spots, and impart overnight golden luminosity.',
    relatedIngredients: ['sea_buckthorn', 'haridra'],
  },
  saffron: {
    id: 'saffron',
    name: 'Kashmiri Saffron (Kesar)',
    aliases: ['kesar', 'crocus sativus', 'zafran', 'saffron'],
    summary: 'The gold standard of botanical radiance (Crocus sativus). Rich in crocin and safranal, it stimulates cellular micro-renewal, accelerates the fading of stubborn post-inflammatory hyperpigmentation, and imparts an incomparable golden warmth and luminosity to the complexion.',
    relatedIngredients: ['kumkumadi', 'haridra'],
  },
});

const PRODUCT_INGREDIENT_GRAPH = Object.freeze({
  sea_buckthorn_face_wash: {
    id: 'sea_buckthorn_face_wash',
    name: 'Bhumivera Sea Buckthorn Face Wash',
    aliases: ['sea buckthorn face wash', 'seabuckthorn face wash', 'seabuck thorn face wash'],
    keyActives: [
      { id: 'sea_buckthorn', name: 'Sea Buckthorn', concentration: 'Listed botanical extract (Omega-7 rich)' },
      { id: 'niacinamide', name: 'Niacinamide (Vitamin B3)', concentration: '1%' },
      { id: 'hyaluronic_acid', name: 'Hyaluronic Acid', concentration: '0.5%' },
      { id: 'aloe_vera', name: 'Aloe Vera', concentration: '5%' },
      { id: 'glycerin', name: 'Botanical Glycerin', concentration: '4%' },
      { id: 'tulsi', name: 'Tulsi', concentration: 'Listed botanical extract' },
    ],
    usage: 'Massage gently on wet skin for 30 to 45 seconds, rinse thoroughly, and follow the directions on the product label.',
  },
  charcoal_face_wash: {
    id: 'charcoal_face_wash',
    name: 'Bhumivera Charcoal Face Wash',
    aliases: ['charcoal face wash', 'activated charcoal face wash'],
    keyActives: [
      { id: 'activated_charcoal', name: 'Activated Charcoal', concentration: '3%' },
      { id: 'glycerin', name: 'Botanical Glycerin', concentration: '5%' },
      { id: 'neem', name: 'Neem', concentration: '0.5%' },
      { id: 'haridra', name: 'Haridra (Turmeric)', concentration: '0.5%' },
      { id: 'hyaluronic_acid', name: 'Hyaluronic Acid', concentration: '0.1%' },
      { id: 'niacinamide', name: 'Niacinamide', concentration: '0.1%' },
    ],
    usage: 'Massage gently on wet skin for 30 to 45 seconds, rinse thoroughly, and follow the directions on the product label.',
  },
  kumkumadi_night_elixir: {
    id: 'kumkumadi_night_elixir',
    name: 'Bhumivera Kumkumadi Night Elixir',
    aliases: ['kumkumadi night elixir', 'kumkumadi elixir', 'kumkumadi tailam', 'night elixir'],
    keyActives: [
      { id: 'haridra', name: 'Haridra (Turmeric)', concentration: 'Curcuminoid Active' },
    ],
    usage: 'Warm 2 to 3 drops between clean palms and gently press onto cleansed face and neck before bedtime.',
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

function buildUsageFollowUpSuggestions(product) {
  const entry = typeof product === 'string'
    ? PRODUCT_INGREDIENT_GRAPH[product] || findByAliases(product, PRODUCT_INGREDIENT_GRAPH)
    : product;
  const prodName = entry?.name ? entry.name.replace(/^Bhumivera\s+/i, '') : 'Sea Buckthorn Face Wash';

  return [
    {
      id: 'post_wash_layering',
      label: '🧴 Post-Wash Layering Guide',
      prompt: `What skincare products should I apply right after using ${prodName}?`,
      category: 'post_wash_routine',
    },
    {
      id: 'active_synergy',
      label: '🌿 Sea Buckthorn + Niacinamide Synergy',
      prompt: `How do Sea Buckthorn and Niacinamide work together in ${prodName}?`,
      category: 'ingredient_synergy',
    },
    {
      id: 'skin_compatibility',
      label: '⚖️ Sensitive & Acne-Prone Skin Guide',
      prompt: `Is ${prodName} safe for sensitive or acne-prone skin, and how do I patch test?`,
      category: 'skin_compatibility',
    },
    {
      id: 'kumkumadi_pairing',
      label: '🌙 Pair with Kumkumadi Night Elixir',
      prompt: `How do I pair ${prodName} with Bhumivera Kumkumadi Night Elixir?`,
      category: 'product_pairing',
    },
  ];
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

  // 1. Post-Wash Layering Guide
  if (/\b(post.?wash|layering|apply right after|after washing|after cleansing|routine order|what to apply)\b/.test(normalizedQuery)) {
    const activeProduct = PRODUCT_INGREDIENT_GRAPH[sessionContext.activeProductId] || product || PRODUCT_INGREDIENT_GRAPH.sea_buckthorn_face_wash;
    return {
      matched: true,
      matchedType: 'post_wash_layering',
      reply: `**Expert Post-Cleansing Layering Ritual (The 60-Second Rule):**\n\n` +
        `Immediately after cleansing with **${activeProduct.name}**, your skin's cellular permeability is at its peak. Here is the recommended botanical layering order:\n\n` +
        `1. **Step 1 — Immediate Damp Hydration (0–60 Seconds):**\n` +
        `   While your face is still dewy from rinsing, mist with pure botanical rosewater or hydrating toner. Never let skin dry out before applying active serums.\n\n` +
        `2. **Step 2 — Active Water-Based Serums:**\n` +
        `   Dispense 3 to 4 drops of targeted serum (such as **Niacinamide** or **Hyaluronic Acid**). Pat gently with fingertips into face and neck.\n\n` +
        `3. **Step 3 — Barrier Moisture Lock:**\n` +
        `   Smooth a pea-sized amount of lightweight gel-cream or restorative moisturizer to seal in the humectants.\n\n` +
        `4. **Step 4 — AM vs PM Ritual Finish:**\n` +
        `   • **☀️ Morning:** Always apply broad-spectrum SPF 50 sunscreen as your final shield.\n` +
        `   • **🌙 Evening:** Warm 2–3 drops of **Bhumivera Kumkumadi Night Elixir** and press gently onto facial contours for overnight cellular nourishment.`,
      quickActions: [
        {
          id: 'kumkumadi_pairing',
          label: '🌙 Pair with Kumkumadi Night Elixir',
          prompt: 'How do I pair Sea Buckthorn Face Wash with Bhumivera Kumkumadi Night Elixir?',
          category: 'product_pairing',
        },
        {
          id: 'ing_niacinamide',
          label: '🌿 Niacinamide Deep Dive',
          prompt: 'Tell me about Niacinamide in Sea Buckthorn Face Wash',
          category: 'ingredient_discovery',
        },
        {
          id: 'skin_compatibility',
          label: '⚖️ Sensitive & Acne-Prone Skin Guide',
          prompt: 'Is Sea Buckthorn Face Wash safe for sensitive or acne-prone skin?',
          category: 'skin_compatibility',
        },
        {
          id: 'brand_ambassador',
          label: '✨ Brand Ambassador Program',
          prompt: 'How do I join the Bhumivera Brand Ambassador Program?',
          category: 'ambassador',
        },
      ],
      updatedContext: { activeProductId: activeProduct.id, lastIngredientId: sessionContext.lastIngredientId || null },
      flowType: 'layering_guide',
      activeProductId: activeProduct.id,
      lastIngredientId: sessionContext.lastIngredientId || null,
    };
  }

  // 2. Botanical & Biochemical Synergy
  if (/\b(synergy|work together|combine|combination of sea buckthorn and niacinamide)\b/.test(normalizedQuery)) {
    const activeProduct = PRODUCT_INGREDIENT_GRAPH[sessionContext.activeProductId] || product || PRODUCT_INGREDIENT_GRAPH.sea_buckthorn_face_wash;
    return {
      matched: true,
      matchedType: 'ingredient_synergy',
      reply: `**Botanical & Biochemical Synergy: Sea Buckthorn + Niacinamide:**\n\n` +
        `In **${activeProduct.name}**, Himalayan Sea Buckthorn and clinical-grade Niacinamide (1%) work in precise harmonic balance:\n\n` +
        `• **Lipid + Moisture Matrix:** Sea Buckthorn delivers rare fat-soluble **Omega-7 (palmitoleic acid)** and carotenoids that reinforce intercellular lipids, while Niacinamide boosts your skin's natural ceramide production.\n\n` +
        `• **Dual Antioxidant Shield:** Sea Buckthorn packs 12x more Vitamin C than oranges to neutralize daytime free-radicals, while Niacinamide quenches cutaneous inflammation and calms post-acne erythema (redness).\n\n` +
        `• **Pore Clarity Without Stripping:** Niacinamide clarifies pores and balances excess sebum, while Botanical Glycerin (4%) and Aloe Vera (5%) maintain a comfortable, hydrated finish.\n\n` +
        `The result is a clean, illuminated, and resilient moisture barrier with zero tight after-feel.`,
      quickActions: [
        {
          id: 'post_wash_layering',
          label: '🧴 Post-Wash Layering Guide',
          prompt: 'What skincare products should I apply right after using Sea Buckthorn Face Wash?',
          category: 'post_wash_routine',
        },
        {
          id: 'skin_compatibility',
          label: '⚖️ Sensitive & Acne-Prone Skin Guide',
          prompt: 'Is Sea Buckthorn Face Wash safe for sensitive or acne-prone skin?',
          category: 'skin_compatibility',
        },
        {
          id: 'ing_hyaluronic',
          label: '💧 Hyaluronic Acid in Cleansers',
          prompt: 'Tell me about Hyaluronic Acid in Sea Buckthorn Face Wash',
          category: 'ingredient_discovery',
        },
        {
          id: 'usage_time',
          label: '⏰ How & What Time to Use Face Wash',
          prompt: 'How do I really use Sea Buckthorn Face Wash and what time of day should I use it?',
          category: 'usage_and_timing',
        },
      ],
      updatedContext: { activeProductId: activeProduct.id, lastIngredientId: sessionContext.lastIngredientId || null },
      flowType: 'ingredient_synergy',
      activeProductId: activeProduct.id,
      lastIngredientId: sessionContext.lastIngredientId || null,
    };
  }

  // 3. Sensitive & Acne-Prone Skin Compatibility
  if (/\b(sensitive skin|acne.?prone|patch test|breakout|irritation|safety for skin|clog pores|non.?comedogenic)\b/.test(normalizedQuery)) {
    const activeProduct = PRODUCT_INGREDIENT_GRAPH[sessionContext.activeProductId] || product || PRODUCT_INGREDIENT_GRAPH.sea_buckthorn_face_wash;
    return {
      matched: true,
      matchedType: 'skin_compatibility',
      reply: `**Dermatological Compatibility & Patch Testing for ${activeProduct.name}:**\n\n` +
        `• **Acne-Prone Skin:** Yes, highly suitable. Formulated to be **non-comedogenic** (will not clog pores). Niacinamide helps regulate sebum production, and Holy Basil Tulsi naturally purifies blemish-causing bacteria without causing flaking or rebound oiliness.\n\n` +
        `• **Sensitive Skin:** Formulated at **pH 5.5** (skin's natural physiological pH) with zero harsh sulphates (SLS/SLES-free), soap, or parabens. Pure Aloe Vera (5%) and Botanical Glycerin (4%) cushion the cleansing base to prevent redness or stinging.\n\n` +
        `• **How to Perform a 24-Hour Patch Test:**\n` +
        `  1. Dispense a pea-sized drop onto your inner wrist or behind your earlobe.\n` +
        `  2. Gently wash off after 45 seconds and wait 24 hours.\n` +
        `  3. If no redness, itching, or irritation appears, incorporate into your daily morning and evening ritual with confidence.`,
      quickActions: [
        {
          id: 'post_wash_layering',
          label: '🧴 Post-Wash Layering Guide',
          prompt: 'What skincare products should I apply right after using Sea Buckthorn Face Wash?',
          category: 'post_wash_routine',
        },
        {
          id: 'active_synergy',
          label: '🌿 Sea Buckthorn + Niacinamide Synergy',
          prompt: 'How do Sea Buckthorn and Niacinamide work together in Sea Buckthorn Face Wash?',
          category: 'ingredient_synergy',
        },
        {
          id: 'kumkumadi_pairing',
          label: '🌙 Pair with Kumkumadi Night Elixir',
          prompt: 'How do I pair Sea Buckthorn Face Wash with Bhumivera Kumkumadi Night Elixir?',
          category: 'product_pairing',
        },
        {
          id: 'human_specialist',
          label: '💬 Speak to Support Specialist',
          prompt: 'Connect me with a human support agent for personalized skin advice',
          category: 'human_escalation',
        },
      ],
      updatedContext: { activeProductId: activeProduct.id, lastIngredientId: sessionContext.lastIngredientId || null },
      flowType: 'skin_compatibility',
      activeProductId: activeProduct.id,
      lastIngredientId: sessionContext.lastIngredientId || null,
    };
  }

  // 4. Product Pairing (Kumkumadi Night Elixir)
  if (/\b(pair.*kumkumadi|kumkumadi.*pair|kumkumadi night elixir|night ritual)\b/.test(normalizedQuery)) {
    return {
      matched: true,
      matchedType: 'product_pairing',
      reply: `**The Golden PM Ritual: Sea Buckthorn Cleanser + Kumkumadi Night Elixir:**\n\n` +
        `This evening ritual pairs gentle deep pore purification with classical Ayurvedic cellular nourishment:\n\n` +
        `• **Phase 1 — The Purifying Canvas (PM):**\n` +
        `  Massage **Bhumivera Sea Buckthorn Face Wash** onto damp skin for **30 to 45 seconds**. This lifts away environmental micro-particulates, day grime, and sunscreen while prepping the skin barrier to receive botanical nutrients.\n\n` +
        `• **Phase 2 — The Golden Elixir Press (PM):**\n` +
        `  While skin is still slightly damp, dispense 2 to 3 drops of **Bhumivera Kumkumadi Night Elixir** into clean palms. Warm the elixir between your hands to activate the authentic Kashmiri Saffron (Kesar), Red Sandalwood, and herbal extracts, then press gently into facial contours and neck.\n\n` +
        `• **Overnight Synergy:**\n` +
        `  While you rest, the micro-nutrients penetrate deep into the relaxed skin barrier to even out skin tone, repair oxidative damage, and reveal a rested, radiant glow by morning.`,
      quickActions: [
        {
          id: 'post_wash_layering',
          label: '🧴 Post-Wash Layering Guide',
          prompt: 'What skincare products should I apply right after using Sea Buckthorn Face Wash?',
          category: 'post_wash_routine',
        },
        {
          id: 'know_sb_fw',
          label: '🌿 Sea Buckthorn Face Wash',
          prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients',
          category: 'product_discovery',
        },
        {
          id: 'shop_offers',
          label: '🛍️ Shop & Active Offers',
          prompt: 'Show my available discount coupons and offers',
          category: 'coupons',
        },
        {
          id: 'brand_ambassador',
          label: '✨ Brand Ambassador Program',
          prompt: 'How do I join the Bhumivera Brand Ambassador Program?',
          category: 'ambassador',
        },
      ],
      updatedContext: { activeProductId: 'sea_buckthorn_face_wash', lastIngredientId: sessionContext.lastIngredientId || null },
      flowType: 'product_pairing',
      activeProductId: 'sea_buckthorn_face_wash',
      lastIngredientId: sessionContext.lastIngredientId || null,
    };
  }

  const isRitualQuery = /\b(when|what\s*time|how\s*often|how\s*long|routine|ritual|rituals|step\s*by\s*step|morning\s*ritual|evening\s*ritual|daily\s*ritual|skincare\s*ritual|am\s*ritual|pm\s*ritual|use|usage|apply|application)\b/.test(normalizedQuery);

  // 5a. Ingredient + Ritual Guide (e.g., Pure Aloe Vera step-by-step ritual)
  if (ingredient && !ingredientOnlyInProductName && isRitualQuery) {
    const activeProduct = PRODUCT_INGREDIENT_GRAPH[sessionContext.activeProductId] || product || PRODUCT_INGREDIENT_GRAPH.sea_buckthorn_face_wash;
    const isListedInProduct = activeProduct?.keyActives.some(active => active.id === ingredient.id);
    const formulationContext = isListedInProduct
      ? `calibrated at therapeutic levels in **${activeProduct.name}**`
      : `formulated in the Bhumivera botanical pharmacopoeia`;

    return {
      matched: true,
      matchedType: 'ingredient_ritual',
      reply: `**${ingredient.name} — Botanical Profile & Daily Step-by-Step Ritual:**\n\n` +
        `• **🌿 Botanical Active Profile & Mechanism:**\n` +
        `  ${ingredient.summary}\n\n` +
        `• **🛡️ Role in the Bhumivera Cleansing Ritual (${activeProduct.name}):**\n` +
        `  As ${formulationContext}, ${ingredient.name} acts in harmony with surrounding barrier lipids and active botanicals (including Himalayan Sea Buckthorn Omega-7, 1% Niacinamide, and Botanical Glycerin) to balance, soothe, and protect the skin barrier against moisture depletion.\n\n` +
        `• **💧 The Signature 5-Step Cleansing & Soothing Ritual:**\n` +
        `  1. **Lukewarm Water Preparation:** Splash face with comfortable lukewarm water (32°C–35°C) to open pores without melting natural barrier lipids.\n` +
        `  2. **Micro-Bubble Lather:** Dispense 1 to 2 coin-sized pumps into clean, damp palms and rub together to create a dense, velvety micro-bubble lather.\n` +
        `  3. **30–45 Second Mindful Massage:** Gently massage over face and neck in upward circular sweeps for **30 to 45 seconds**, allowing ${ingredient.name} and the bioactives to calm redness, regulate excess sebum, and dissolve impurities without mechanical friction.\n` +
        `  4. **Cool Water Rinse & Muslin Blot:** Rinse thoroughly with cool water to refresh the pores and awaken cutaneous microcirculation. Gently blot with a clean muslin towel — leaving skin dewy and slightly damp.\n` +
        `  5. **The 60-Second Layering Rule:** Within 60 seconds of patting dry, mist with botanical toner or hydrating essence, follow with active serum (such as Niacinamide or Hyaluronic Acid), and seal with moisturizer or broad-spectrum SPF 50 (AM) or 2–3 drops of **Kumkumadi Night Elixir** (PM).\n\n` +
        `• **☀️ AM vs. 🌙 PM Ritual:**\n` +
        `  In the morning, use to sweep away overnight metabolic residue and prime your antioxidant shield; in the evening, use to lift away urban pollutants, day grime, and sunscreen.`,
      quickActions: [
        {
          id: 'post_wash_layering',
          label: '🧴 Post-Wash Layering Guide',
          prompt: `What skincare products should I apply right after using ${activeProduct.name.replace(/^Bhumivera\s+/i, '')}?`,
          category: 'post_wash_routine',
        },
        {
          id: 'active_synergy',
          label: '🌿 Active Synergy Guide',
          prompt: `How do ${ingredient.name} and Niacinamide work together in ${activeProduct.name}?`,
          category: 'ingredient_synergy',
        },
        {
          id: 'kumkumadi_pairing',
          label: '🌙 Pair with Kumkumadi Night Elixir',
          prompt: 'How do I pair my cleanser with Bhumivera Kumkumadi Night Elixir?',
          category: 'product_pairing',
        },
        {
          id: 'skin_compatibility',
          label: '⚖️ Sensitive & Acne-Prone Skin Guide',
          prompt: `Is ${activeProduct.name} safe for sensitive or acne-prone skin?`,
          category: 'skin_compatibility',
        },
      ],
      updatedContext: { activeProductId: activeProduct.id, lastIngredientId: ingredient.id },
      flowType: 'ingredient_ritual',
      activeProductId: activeProduct.id,
      lastIngredientId: ingredient.id,
    };
  }

  // 5b. Product Usage & Daily Ritual Guide
  if (isRitualQuery && product) {
    return {
      matched: true,
      matchedType: 'usage',
      reply: `**Best Time to Use & Daily Skincare Ritual for ${product.name}:**\n\n` +
        `• **☀️ Morning (AM) Ritual — Antioxidant Shield:**\n` +
        `  Cleanse gently upon waking to sweep away overnight sebum and metabolic residue. The natural **Sea Buckthorn (Omega-7)** and **Niacinamide (1%)** work synergistically to create a radiant antioxidant shield against daytime pollutants and oxidative stress.\n\n` +
        `• **🌙 Evening (PM) Ritual — Restorative Barrier Reset:**\n` +
        `  Cleanse at dusk or before bed to dissolve accumulated sunscreen, dust, and urban grime. Infused with **Hyaluronic Acid (0.5%)** and **Botanical Glycerin (4%)**, it thoroughly purifies without stripping your skin's vital lipid moisture barrier.\n\n` +
        `• **💧 Step-by-Step Application Technique:**\n` +
        `  1. Splash your face with comfortable lukewarm water (avoid hot water, which strips natural sebum).\n` +
        `  2. Dispense 1 to 2 coin-sized pumps into clean, damp palms and work into a rich micro-bubble lather.\n` +
        `  3. Gently massage over face and neck in upward circular motions for **30 to 45 seconds**, focusing on the T-zone while avoiding direct contact with the eyes.\n` +
        `  4. Rinse thoroughly with cool water to refresh the pores, then pat gently with a clean muslin towel — leaving skin slightly damp for subsequent steps.\n\n` +
        `• **🧴 Post-Cleansing Layering Order:**\n` +
        `  *Face Wash* ➔ *Hydrating Toner / Mist* ➔ *Active Serum (Niacinamide / Vitamin C)* ➔ *Moisturizer / Kumkumadi Night Elixir* ➔ *Broad Spectrum SPF (AM only)*.\n\n` +
        `• **🌿 Skin Compatibility & Safety:**\n` +
        `  Formulated at skin-identical **pH 5.5**, soap-free, non-comedogenic, and safe for sensitive, oily, or acne-prone skin. Follow the product label for frequency and conduct a 24-hour patch test before first use.`,
      quickActions: buildUsageFollowUpSuggestions(product),
      updatedContext: { activeProductId: product.id, lastIngredientId: sessionContext.lastIngredientId || null },
      flowType: 'usage_guide',
      activeProductId: product.id,
      lastIngredientId: sessionContext.lastIngredientId || null,
    };
  }

  // 5c. General Skincare Ritual & Routine Guide (when no specific product/ingredient is named)
  if (isRitualQuery && !ingredient) {
    const activeProduct = PRODUCT_INGREDIENT_GRAPH[sessionContext.activeProductId] || PRODUCT_INGREDIENT_GRAPH.sea_buckthorn_face_wash;
    return {
      matched: true,
      matchedType: 'skincare_ritual',
      reply: `**The Signature Bhumivera Daily Skincare Ritual (AM & PM):**\n\n` +
        `Our clean botanical rituals are engineered to cleanse, balance, and rejuvenate your skin barrier without aggressive chemicals or tight after-feel:\n\n` +
        `• **☀️ Morning (AM) Ritual — Antioxidant Shield & Hydration:**\n` +
        `  1. **Purify:** Cleanse with **${activeProduct.name}** for 30–45 seconds with lukewarm water to remove overnight sebum and activate the Omega-7 and Niacinamide (1%) antioxidant shield.\n` +
        `  2. **Hydrate:** Within 60 seconds of patting dry, apply botanical toner or hydrating mist to damp skin.\n` +
        `  3. **Treat:** Dispense 3–4 drops of active serum (Hyaluronic Acid or Niacinamide) and pat into skin.\n` +
        `  4. **Protect:** Seal with lightweight moisturizer and finish with a broad-spectrum **SPF 50 sunscreen**.\n\n` +
        `• **🌙 Evening (PM) Ritual — Restorative Barrier Reset & Cellular Renewal:**\n` +
        `  1. **Purify:** Massage **${activeProduct.name}** over damp skin to dissolve accumulated dust, environmental pollutants, and daytime sunscreen.\n` +
        `  2. **Rinse & Blot:** Rinse with cool water to soothe pores and lightly blot with a soft muslin towel.\n` +
        `  3. **Elixir Press:** Warm 2 to 3 drops of **Bhumivera Kumkumadi Night Elixir** (authentic 26-herb Kashmiri Saffron formula) between your palms and gently press into face and neck for deep overnight restoration.\n\n` +
        `• **🌿 Safety & Skin Compatibility:**\n` +
        `  Formulated at physiological **pH 5.5**, SLS/SLES sulphate-free, non-comedogenic, and dermatologically tested for all skin types including sensitive and acne-prone skin.`,
      quickActions: [
        {
          id: 'post_wash_layering',
          label: '🧴 Post-Wash Layering Guide',
          prompt: `What skincare products should I apply right after using ${activeProduct.name.replace(/^Bhumivera\s+/i, '')}?`,
          category: 'post_wash_routine',
        },
        {
          id: 'know_sb_fw',
          label: '🌿 Sea Buckthorn Face Wash',
          prompt: 'Tell me about Sea Buckthorn Face Wash and its key ingredients',
          category: 'product_discovery',
        },
        {
          id: 'kumkumadi_pairing',
          label: '🌙 Pair with Kumkumadi Night Elixir',
          prompt: 'How do I pair Sea Buckthorn Face Wash with Bhumivera Kumkumadi Night Elixir?',
          category: 'product_pairing',
        },
        {
          id: 'skin_compatibility',
          label: '⚖️ Sensitive & Acne-Prone Skin Guide',
          prompt: `Is ${activeProduct.name} safe for sensitive or acne-prone skin?`,
          category: 'skin_compatibility',
        },
      ],
      updatedContext: { activeProductId: activeProduct.id, lastIngredientId: sessionContext.lastIngredientId || null },
      flowType: 'skincare_ritual',
      activeProductId: activeProduct.id,
      lastIngredientId: sessionContext.lastIngredientId || null,
    };
  }

  // 6. Ingredient Deep Dive
  if (ingredient && !ingredientOnlyInProductName) {
    const activeProduct = PRODUCT_INGREDIENT_GRAPH[sessionContext.activeProductId] || product;
    const isListedInProduct = activeProduct?.keyActives.some(active => active.id === ingredient.id);
    const productNote = activeProduct
      ? isListedInProduct
        ? ` It is calibrated and listed in ${activeProduct.name}; check packaging for complete formulation details.`
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

  // 7. Product Discovery
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
  buildUsageFollowUpSuggestions,
};
