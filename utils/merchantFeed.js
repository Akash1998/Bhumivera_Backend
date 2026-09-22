const pool = require('../config/db');

const generateGoogleMerchantFeed = async () => {
  try {
    const [products] = await pool.query('SELECT * FROM products WHERE status = "active" AND quantity > 0');

    let xml = `<?xml version="1.0"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <title>Bhumivera | Luxury 100% Natural Skincare</title>
    <link>https://bhumivera.com</link>
    <description>100% natural, fragrance-free, and preservative-free luxury skincare.</description>
`;

    products.forEach(p => {
      xml += `    <item>
      <g:id>${p.id}</g:id>
      <g:title><![CDATA[${p.name} | Bhumivera]]></g:title>
      <g:description><![CDATA[${p.description} 100% natural and fragrance-free.]]></g:description>
      <g:link>https://bhumivera.com/product/${p.slug || p.id}</g:link>
      <g:image_link>${p.images ? JSON.parse(p.images)[0] : 'https://bhumivera.com/assets/images/logo.webp'}</g:image_link>
      <g:availability>in_stock</g:availability>
      <g:price>${p.price} INR</g:price>
      <g:brand>Bhumivera</g:brand>
    </item>\n`;
    });

    return xml + `  </channel>\n</rss>`;
  } catch (error) {
    throw new Error('Feed Generation Failed: ' + error.message);
  }
};

module.exports = { generateGoogleMerchantFeed };
