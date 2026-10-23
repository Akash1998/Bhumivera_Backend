const pool = require('../config/db');
const { cleanProductMarketingFields } = require('./productMarketingClaims');

const escapeXml = value => String(value ?? '').replace(/[<>&'"]/g, character => ({
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&apos;',
  '"': '&quot;',
}[character]));

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
    <title>Bhumivera Organics | The Synchronized Gut-Skin Biotic Protocol &amp; Postbiotic Cellular Skincare</title>
    <link>https://www.bhumivera.com</link>
    <description>Shop Bhumivera Organics India Private Limited: India's pioneering Synchronized Inside-Out Gut-Skin Biotic Protocol uniting 90% Kalpvriksh Satva 7-Tulsi Cellular Reset Drops with 4% Himalayan Sea Buckthorn &amp; 3% Activated Charcoal Postbiotic Cellular Emulsions at pH 5.3–5.5.</description>
`;

    products.forEach(product => {
      const p = cleanProductMarketingFields(product);
      const imagePath = p.primary_image || p.image_url;
      const imageUrl = imagePath
        ? (/^https?:\/\//i.test(imagePath) ? imagePath : `${imageBaseUrl}/${String(imagePath).replace(/^\/+/, '')}`)
        : 'https://www.bhumivera.com/logo.webp';
      xml += `    <item>
      <g:id>${escapeXml(p.sku || p.id)}</g:id>
      <g:title>${escapeXml(p.seo_title || `${p.name} | Bhumivera Organics`)}</g:title>
      <g:description>${escapeXml(p.short_description || p.meta_description || p.description || p.name || 'Bhumivera Organics luxury botanical formulation')}</g:description>
      <g:link>${escapeXml(`https://www.bhumivera.com/product/${p.slug || p.id}`)}</g:link>
      <g:image_link>${escapeXml(imageUrl)}</g:image_link>
      <g:condition>new</g:condition>
      <g:availability>in_stock</g:availability>
      <g:price>${escapeXml(`${p.discount_price || p.price} INR`)}</g:price>
      <g:brand>Bhumivera Organics</g:brand>
      <g:mpn>${escapeXml(p.mpn || p.sku || `BVLUX-${p.id}`)}</g:mpn>
      <g:google_product_category>Health &amp; Beauty &gt; Personal Care &gt; Cosmetics</g:google_product_category>
    </item>\n`;
    });

    return xml + `  </channel>\n</rss>`;
  } catch (error) {
    throw new Error('Feed Generation Failed: ' + error.message);
  }
};

module.exports = { generateGoogleMerchantFeed };
