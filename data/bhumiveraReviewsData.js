const REVIEW_MEDIA_PLACEHOLDER = '/images/review-placeholder.svg';

const PRODUCT_SEEDS = [
  {
    id: 1,
    slug: 'activated-charcoal-luxury-face-wash',
    ratings: { 5: 174, 4: 24, 3: 9, 2: 4, 1: 9 },
    photos: 86,
    videos: 16,
    combo: { ratings: { 5: 77, 4: 1 }, photos: 36, videos: 8 },
  },
  {
    id: 2,
    slug: 'himalayan-seabuckthorn-luxury-face-wash',
    ratings: { 5: 192, 4: 25, 3: 10, 2: 4, 1: 9 },
    photos: 124,
    videos: 16,
    combo: { ratings: { 5: 84, 4: 1 }, photos: 52, videos: 8 },
  },
  {
    id: 3,
    slug: 'luxury-2-in-1-botanical-shampoo-conditioner',
    ratings: { 5: 124, 4: 17, 3: 7, 2: 4, 1: 8 },
    photos: 55,
    videos: 11,
    combo: { ratings: { 5: 56, 4: 1 }, photos: 23, videos: 5 },
  },
  {
    id: 4,
    slug: 'artisanal-charcoal-handmade-soap',
    ratings: { 5: 102, 4: 12, 3: 5, 2: 3, 1: 8 },
    photos: 44,
    videos: 9,
    combo: { ratings: { 5: 45, 4: 1 }, photos: 18, videos: 4 },
  },
  {
    id: 5,
    slug: 'artisanal-aloe-vera-handmade-soap',
    ratings: { 5: 95, 4: 10, 3: 4, 2: 3, 1: 8 },
    photos: 42,
    videos: 8,
    combo: { ratings: { 5: 42 }, photos: 18, videos: 4 },
  },
  {
    id: 6,
    slug: 'kalpvriksh-satva-tulsi-7-tulsi-extract',
    ratings: { 5: 170, 4: 20, 3: 8, 2: 4, 1: 8 },
    photos: 84,
    videos: 14,
    combo: { ratings: { 5: 47, 4: 20, 3: 3 }, photos: 35, videos: 9 },
  },
];

const NAMES = [
  'Aarav', 'Ananya', 'Ishita', 'Rohan', 'Meera', 'Kabir', 'Naina', 'Vihaan', 'Saanvi', 'Arjun',
  'Diya', 'Kunal', 'Tara', 'Neha', 'Rahul', 'Priya', 'Siddharth', 'Riya', 'Aditya', 'Pooja',
];
const SURNAMES = ['Sharma', 'Verma', 'Singh', 'Mehta', 'Nair', 'Iyer', 'Gupta', 'Rao', 'Kapoor', 'Joshi', 'Bose', 'Khan'];
const CITIES = ['Delhi', 'Mumbai', 'Bengaluru', 'Pune', 'Chennai', 'Kolkata', 'Jaipur', 'Dehradun', 'Hyderabad', 'Lucknow'];
const TITLES = ['Visible difference', 'Gentle yet effective', 'Worth it', 'Skin feels balanced', 'Love the texture', 'Repurchasing'];
const BODIES = [
  'My skin feels calmer and clearer after a few weeks of regular use.',
  'Lovely texture and a subtle natural scent. No tightness after washing.',
  'Noticed a more even tone and less oiliness through the day.',
  'Gentle on my sensitive skin and absorbs quickly. Will buy again.',
  'Premium feel, thoughtful formulation, and it works well for my routine.',
];
const CATEGORIES = [
  'Quick & Everyday Impressions',
  'Texture & Sensory Notes',
  'Routine & Ritual',
  'Sensitive Skin Journal',
  'Long-Term Experience',
];

const buildSeed = () => {
  const reviews = [];
  let sequence = 0;

  for (const product of PRODUCT_SEEDS) {
    const comboRatingsRemaining = { ...product.combo.ratings };
    let comboPhotosRemaining = product.combo.photos;
    let comboVideosRemaining = product.combo.videos;
    let photosRemaining = product.photos - product.combo.photos;
    let videosRemaining = product.videos - product.combo.videos;

    for (const rating of [5, 4, 3, 2, 1]) {
      for (let index = 0; index < product.ratings[rating]; index += 1) {
        const isComboReview = (comboRatingsRemaining[rating] || 0) > 0;
        if (isComboReview) comboRatingsRemaining[rating] -= 1;

        const hasPhoto = isComboReview ? comboPhotosRemaining > 0 : photosRemaining > 0;
        const hasVideo = isComboReview ? comboVideosRemaining > 0 : videosRemaining > 0;
        if (hasPhoto && isComboReview) comboPhotosRemaining -= 1;
        else if (hasPhoto) photosRemaining -= 1;
        if (hasVideo && isComboReview) comboVideosRemaining -= 1;
        else if (hasVideo) videosRemaining -= 1;

        const reviewerName = `${NAMES[(sequence * 7) % NAMES.length]} ${SURNAMES[(sequence * 5 + product.id) % SURNAMES.length]}`;
        const body = BODIES[(sequence + product.id) % BODIES.length];
        const isCombo = Boolean(isComboReview);
        const createdAt = new Date(Date.UTC(2020, 0, 1) + sequence * 54 * 60 * 60 * 1000).toISOString();

        reviews.push({
          id: sequence + 1,
          product_id: product.id,
          product_slug: product.slug,
          order_number: `BV-ORD-${String(sequence + 1).padStart(6, '0')}`,
          reviewer_name: reviewerName,
          user_name: reviewerName,
          reviewer_location: CITIES[(sequence * 3) % CITIES.length],
          category_tag: isCombo ? 'Combo Pack Ritual' : CATEGORIES[sequence % CATEGORIES.length],
          is_combo_review: isCombo,
          combo_name: isCombo ? (sequence % 2 ? 'Inside-Out Ritual' : 'Daily Regimen') : null,
          rating,
          title: TITLES[sequence % TITLES.length],
          body,
          images: hasPhoto ? [REVIEW_MEDIA_PLACEHOLDER] : [],
          videos: hasVideo ? [REVIEW_MEDIA_PLACEHOLDER] : [],
          helpful_count: sequence % 24,
          public_story_consent: false,
          is_approved: 1,
          created_at: createdAt,
        });

        sequence += 1;
      }
    }
  }

  return reviews;
};

const INITIAL_REVIEWS_SEED = buildSeed();

module.exports = { INITIAL_REVIEWS_SEED };
