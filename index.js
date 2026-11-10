/**
 * Bhumivera Organics - Express Server Entry File (server/index.js)
 * Mounts createSeoPrerenderMiddleware and /sitemap.xml via the primary Express app.
 */
const path = require("path");
const app = require("./server");
const { createSeoPrerenderMiddleware, sitemapController } = require("./middleware/seoPrerender");

module.exports = app;
module.exports.createSeoPrerenderMiddleware = createSeoPrerenderMiddleware;
module.exports.sitemapController = sitemapController;
