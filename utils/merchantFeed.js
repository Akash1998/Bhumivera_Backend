const pool = require('../config/db');
const { cleanProductMarketingFields } = require('./productMarketingClaims');
const { BHUMIVERA_6_PRODUCTS } = require('../data/bhumiveraCatalog');

const escapeXml = value => String(value ?? '').replace(/[<>&'"]/g, character => ({
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&apos;',
  '"': '&quot;',
}[character]));

const getGoogleCategory = (name = '', category = '') => {
  const text = `${name} ${category}`.toLowerCase();
  if (text.includes('face wash') || text.includes('facial cleanser')) {
    return 'Health &amp; Beauty &gt; Personal Care &gt; Cosmetics &gt; Skin Care &gt; Facial Cleansers';
  }
  if (text.includes('shampoo')) {
    return 'Health &amp; Beauty &gt; Personal Care &gt; Hair Care &gt; Shampoo &amp; Conditioner';
  }
  if (text.includes('soap') || text.includes('bar')) {
    return 'Health &amp; Beauty &gt; Personal Care &gt; Cosmetics &gt; Bath &amp; Body &gt; Bar Soap';
  }
  if (text.includes('tulsi') || text.includes('drops')) {
    return 'Health &amp; Beauty &gt; Health Care &gt; Dietary Supplements';
  }
  return 'Health &amp; Beauty &gt; Personal Care &gt; Cosmetics';
};

const generateGoogleMerchantFeed = async () => {
  try {
    const [products] = await pool.query(`
      SELECT p.*,
        (SELECT file_path FROM product_images
         WHERE product_id = p.id AND media_type = 'image'
         ORDER BY sort_order ASC, id ASC LIMIT 1) AS primary_image
      FROM products p
      WHERE p.status = 'active' AND p.quantity > 0
    `);
    const imageBaseUrl = (process.env.CLOUDFRONT_BASE_URL ||
      'https://pub-70fdb5d94df347c4bed417c28b066c02.r2.dev/bhumivera').replace(/\/+$/, '');

    let xml = `<?xml version="1.0"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <title>Bhumivera Organics | Luxury Botanical Skincare &amp; Haircare Collection</title>
    <link>https://www.bhumivera.com</link>
    <description>Shop Bhumivera Organics India Private Limited: pH-balanced luxury Ayurvedic-inspired &amp; botanical face washes, 2-in-1 shampoo, handmade soaps, and 7-Tulsi drops with 100% label-disclosed active concentrations.</description>
`;

    products.forEach(product => {
      const p = cleanProductMarketingFields(product);
      const catalogMatch = BHUMIVERA_6_PRODUCTS.find(c =>
        c.slug === p.slug ||
        c.sku === p.sku ||
        c.name.toLowerCase() === p.name.toLowerCase() ||
        (p.name.toLowerCase().includes('sea buckthorn') && c.slug.includes('seabuckthorn')) ||
        (p.name.toLowerCase().includes('charcoal') && p.name.toLowerCase().includes('face wash') && c.slug.includes('charcoal-luxury-face-wash'))
      );

      const title = p.meta_title || catalogMatch?.seo_title || `${p.name} | Bhumivera Organics`;
      const description = p.meta_description || catalogMatch?.meta_description || catalogMatch?.short_description || p.description || 'Bhumivera Organics luxury botanical formulation';
      const imagePath = p.primary_image || p.image_url || catalogMatch?.image_url;
      const imageUrl = imagePath
        ? (/^https?:\/\//i.test(imagePath) ? imagePath : `${imageBaseUrl}/${String(imagePath).replace(/^\/+/, '')}`)
        : 'https://www.bhumivera.com/logo.webp';
      const googleCategory = getGoogleCategory(p.name, p.category_name || catalogMatch?.category);

      xml += `    <item>
      <g:id>${escapeXml(p.sku || catalogMatch?.sku || `BV-LUX-${p.id}`)}</g:id>
      <g:title>${escapeXml(title)}</g:title>
      <g:description>${escapeXml(description)}</g:description>
      <g:link>${escapeXml(`https://www.bhumivera.com/product/${p.slug || catalogMatch?.slug || p.id}`)}</g:link>
      <g:image_link>${escapeXml(imageUrl)}</g:image_link>
      <g:condition>new</g:condition>
      <g:availability>in_stock</g:availability>
      <g:price>${escapeXml(`${p.discount_price || p.price || 699} INR`)}</g:price>
      <g:brand>Bhumivera Organics</g:brand>
      <g:mpn>${escapeXml(p.mpn || catalogMatch?.mpn || p.sku || `BVLUX-${p.id}`)}</g:mpn>
      <g:gtin>${escapeXml(catalogMatch?.gtin13 || '8906182600018')}</g:gtin>
      <g:google_product_category>${googleCategory}</g:google_product_category>
      <g:product_type>${escapeXml(catalogMatch?.category || p.category_name || 'Luxury Botanical Personal Care')}</g:product_type>
    </item>\n`;
    });

    return xml + `  </channel>\n</rss>`;
  } catch (error) {
    throw new Error('Feed Generation Failed: ' + error.message);
  }
};

module.exports = { generateGoogleMerchantFeed };
