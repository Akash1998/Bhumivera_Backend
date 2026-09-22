// backend/models/cartModel.js
const pool = require('../config/db');

const createCartTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cart_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        product_id INT NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_product (user_id, product_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    const [indexes] = await pool.query("SHOW INDEX FROM cart_items WHERE Key_name = 'uq_user_product'");
    if (indexes.length === 0) {
      console.log("[DB] Adding missing unique constraint to cart_items...");
      await pool.query("ALTER TABLE cart_items ADD UNIQUE KEY uq_user_product (user_id, product_id)");
    }

    const [fk] = await pool.query(`
      SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE 
      WHERE TABLE_NAME = 'cart_items' AND COLUMN_NAME = 'user_id' AND REFERENCED_TABLE_NAME = 'users'
    `);
    if (fk.length === 0) {
       await pool.query("ALTER TABLE cart_items ADD CONSTRAINT fk_cart_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE");
    }
  } catch (err) {
    console.error("[DB] cartModel migration error:", err.message);
  }
};

const getCartByUser = async (userId) => {
  try {
    const [rows] = await pool.query(
      `SELECT ci.id, ci.quantity, ci.product_id, 
              p.name, p.price, p.discount_price, p.quantity AS stock,
              p.status, p.sku, p.brand,
              (SELECT file_path FROM product_images WHERE product_id = p.id LIMIT 1) AS image
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = ?`,
      [userId]
    );

    return rows.map((r) => {
      const activePrice = (r.discount_price !== null && r.discount_price !== "") ? r.discount_price : r.price;
      return {
        ...r,
        unit_price: parseFloat(activePrice),
        subtotal: parseFloat(activePrice) * r.quantity,
      };
    });
  } catch (err) {
    console.error("getCartByUser Error:", err);
    throw err;
  }
};

const upsertCartItem = async (userId, productId, quantity) => {
  try {
    const [products] = await pool.query(
      "SELECT id, quantity, status FROM products WHERE id = ?",
      [productId]
    );
    
    if (!products.length || products[0].status !== 'active') {
      throw { status: 400, message: 'Product is not available.' };
    }

    const [existing] = await pool.query(
      "SELECT quantity FROM cart_items WHERE user_id = ? AND product_id = ?",
      [userId, productId]
    );

    const currentQtyInCart = existing.length > 0 ? existing[0].quantity : 0;
    const totalRequested = currentQtyInCart + quantity;

    if (products[0].quantity < totalRequested) {
      throw { 
        status: 400, 
        message: `Stock limit reached. You have ${currentQtyInCart} in cart and tried to add ${quantity}. Only ${products[0].quantity} available.` 
      };
    }

    await pool.query(
      `INSERT INTO cart_items (user_id, product_id, quantity) 
       VALUES (?, ?, ?) 
       ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
      [userId, productId, quantity, quantity]
    );

    return getCartByUser(userId);
  } catch (err) {
    // FIXED: Catch orphaned user session error (Foreign Key Constraint 1452)
    if (err.errno === 1452) {
      console.error("[Cart DB] Orphaned session detected for user_id:", userId);
      throw { status: 401, message: "Session expired or user not found. Please log out and log back in." };
    }
    console.error("upsertCartItem Error:", err);
    throw err;
  }
};

const updateCartItemQuantity = async (userId, productId, quantity) => {
  if (quantity < 1) return removeCartItem(userId, productId);
  
  const [products] = await pool.query(
    "SELECT id, quantity, status FROM products WHERE id = ?",
    [productId]
  );
  
  if (!products.length || products[0].status !== 'active') {
    throw { status: 400, message: 'Product is no longer available.' };
  }

  if (products[0].quantity < quantity) {
    throw { status: 400, message: `Only ${products[0].quantity} item(s) available.` };
  }

  await pool.query(
    'UPDATE cart_items SET quantity = ? WHERE user_id = ? AND product_id = ?',
    [quantity, userId, productId]
  );
  
  return getCartByUser(userId);
};

const removeCartItem = async (userId, productId) => {
  await pool.query(
    'DELETE FROM cart_items WHERE user_id = ? AND product_id = ?',
    [userId, productId]
  );
  return getCartByUser(userId);
};

const clearCart = async (userId) => {
  await pool.query('DELETE FROM cart_items WHERE user_id = ?', [userId]);
};

const getCartTotal = async (userId) => {
  const items = await getCartByUser(userId);
  const total = items.reduce((sum, i) => sum + i.subtotal, 0);
  return { items, total: parseFloat(total.toFixed(2)) };
};

module.exports = { 
  getCartByUser, 
  upsertCartItem, 
  updateCartItemQuantity,
  removeCartItem, 
  clearCart, 
  getCartTotal, 
  createCartTable 
};
