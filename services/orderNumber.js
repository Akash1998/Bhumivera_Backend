const crypto = require('crypto');

const generateOrderNumber = () => String(crypto.randomInt(100_000_000, 1_000_000_000));

module.exports = { generateOrderNumber };
