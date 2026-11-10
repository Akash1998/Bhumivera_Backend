const correctOutdatedSiteMetadata = async pool => {
  await pool.query(
    `UPDATE settings
     SET value = ?, group_name = 'seo'
     WHERE key_name = 'meta_description'
       AND value = 'Best electronics at best prices'`,
    ['Botanical skincare shaped by plant science and crafted for everyday rituals.']
  );
  await pool.query(
    `UPDATE settings
     SET value = ?, group_name = 'seo'
     WHERE key_name = 'meta_keywords'
       AND value = 'electronics, gadgets, Bhumivera'`,
    ['botanical skincare, plant-based skincare, Bhumivera']
  );
};

module.exports = { correctOutdatedSiteMetadata };
