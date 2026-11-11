const getBundleComponents = specifications => {
  let parsed = specifications;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  const isBundle = parsed?.product_type === 'bundle' || parsed?.product_type === 'combo' || Boolean(parsed?.is_combo);
  if (!isBundle) return null;

  const rawList = parsed.components || parsed.combo_items || parsed.items;
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new Error('Bundle inventory configuration is invalid.');
  }

  return rawList.map(item => {
    if (!item || typeof item !== 'object') {
      throw new Error('Bundle inventory configuration is invalid.');
    }
    const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
    const productId = item.product_id != null
      ? Number(item.product_id)
      : (item.id != null ? Number(item.id) : null);

    if (!slug && (!Number.isInteger(productId) || productId < 1)) {
      throw new Error('Bundle inventory configuration is invalid.');
    }
    const res = { ...item };
    if (slug) res.slug = slug;
    if (Number.isInteger(productId) && productId > 0) res.product_id = productId;
    return res;
  });
};

const getBundleAvailableStock = async (database, specifications) => {
  const components = getBundleComponents(specifications);
  if (!components) return null;

  const slugComponents = components.filter(c => c.slug);
  const idComponents = components.filter(c => !c.slug && c.product_id != null);

  const stockById = new Map();
  const stockBySlug = new Map();

  if (idComponents.length > 0) {
    const ids = [...new Set(idComponents.map(c => c.product_id))];
    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await database.query(
      `SELECT id, slug, quantity, status FROM products WHERE id IN (${placeholders})`,
      ids
    );
    for (const row of rows) {
      const available = row.status && row.status !== 'active' ? 0 : Math.max(0, Number(row.quantity) || 0);
      stockById.set(Number(row.id), available);
      if (row.slug) stockBySlug.set(row.slug, available);
    }
    if (ids.some(id => !stockById.has(id))) {
      throw new Error('Bundle inventory could not be verified.');
    }
  }

  if (slugComponents.length > 0) {
    const slugs = [...new Set(slugComponents.map(c => c.slug))];
    const placeholders = slugs.map(() => '?').join(', ');
    const [rows] = await database.query(
      `SELECT id, slug, quantity, status FROM products WHERE slug IN (${placeholders})`,
      slugs
    );
    for (const row of rows) {
      const available = row.status && row.status !== 'active' ? 0 : Math.max(0, Number(row.quantity) || 0);
      stockBySlug.set(row.slug, available);
      if (row.id) stockById.set(Number(row.id), available);
    }
    if (slugs.some(slug => !stockBySlug.has(slug))) {
      throw new Error('Bundle inventory could not be verified.');
    }
  }

  const availableCombos = components.map(c => {
    const stock = c.slug ? stockBySlug.get(c.slug) : stockById.get(c.product_id);
    const reqPerCombo = Math.max(1, Number(c.quantity) || 1);
    return Math.floor((stock || 0) / reqPerCombo);
  });

  return Math.max(0, Math.min(...availableCombos));
};

module.exports = { getBundleComponents, getBundleAvailableStock };
