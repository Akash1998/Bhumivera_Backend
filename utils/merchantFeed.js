const pool = require('../config/db');

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
    <title>Bhumivera | Product collection</title>
    <link>https://bhumivera.com</link>
    <description>Explore Bhumivera products and review the product-specific details provided for each item.</description>
`;

    products.forEach(p => {
      const imagePath = p.primary_image;
      const imageUrl = imagePath
        ? (/^https?:\/\//i.test(imagePath) ? imagePath : `${imageBaseUrl}/${String(imagePath).replace(/^\/+/, '')}`)
        : 'https://bhumivera.com/logo.webp';
      xml += `    <item>
      <g:id>${escapeXml(p.id)}</g:id>
      <g:title>${escapeXml(`${p.name} | Bhumivera`)}</g:title>
      <g:description>${escapeXml(p.description || p.name || 'Bhumivera product')}</g:description>
      <g:link>${escapeXml(`https://bhumivera.com/product/${p.slug || p.id}`)}</g:link>
      <g:image_link>${escapeXml(imageUrl)}</g:image_link>
      <g:availability>in_stock</g:availability>
      <g:price>${escapeXml(`${p.discount_price || p.price} INR`)}</g:price>
      <g:brand>Bhumivera</g:brand>
    </item>\n`;
    });

    return xml + `  </channel>\n</rss>`;
  } catch (error) {
    throw new Error('Feed Generation Failed: ' + error.message);
  }
};

module.exports = { generateGoogleMerchantFeed };
