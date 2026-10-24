const getBundleComponents = specifications => {
  let parsed = specifications;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (parsed?.product_type !== 'bundle') return null;
  if (!Array.isArray(parsed.components) || parsed.components.length === 0 ||
      parsed.components.some(component => typeof component?.slug !== 'string' || !component.slug.trim())) {
    throw new Error('Bundle inventory configuration is invalid.');
  }
  return parsed.components;
};

const getBundleAvailableStock = async (database, specifications) => {
  const components = getBundleComponents(specifications);
  if (!components) return null;
  const slugs = [...new Set(components.map(component => component.slug))];
  const placeholders = slugs.map(() => '?').join(', ');
  const [rows] = await database.query(
    `SELECT slug, quantity, status FROM products WHERE slug IN (${placeholders})`,
    slugs
  );
  const stockBySlug = new Map(rows.map(row => [
    row.slug,
    row.status && row.status !== 'active' ? 0 : Number(row.quantity),
  ]));
  if (slugs.some(slug => !stockBySlug.has(slug))) {
    throw new Error('Bundle inventory could not be verified.');
  }
  return Math.max(0, Math.min(...slugs.map(slug => stockBySlug.get(slug))));
};

module.exports = { getBundleComponents, getBundleAvailableStock };
