const { Pinecone } = require('@pinecone-database/pinecone');
const pool = require('../config/db');

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const indexName = 'Bhumivera-products';

// Singleton pattern to load the AI model once in memory
let extractorPipeline;

async function getExtractor() {
  if (!extractorPipeline) {
    // Dynamically import the local AI model
    const { pipeline } = await import('@xenova/transformers');
    // Using MiniLM: extremely fast, lightweight, and 100% free
    extractorPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return extractorPipeline;
}

/**
 * Generates an embedding vector locally (Free)
 */
async function generateEmbedding(text) {
  const extractor = await getExtractor();
  // Generate the 384-dimensional vector
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Synchronizes a product to the Vector Database
 */
async function syncProductToVectorDB(product) {
  try {
    const index = pinecone.index(indexName);
    
    const contentToEmbed = `
      Product: ${product.name}
      Category: ${product.category_id}
      Brand: ${product.brand || 'Bhumivera'}
      Description: ${product.description}
      Tags: ${product.tags || ''}
      Specifications: ${product.specifications || ''}
    `.trim();

    const embedding = await generateEmbedding(contentToEmbed);

    await index.upsert([{
      id: product.id.toString(),
      values: embedding,
      metadata: {
        name: product.name,
        category_id: product.category_id,
        price: product.price,
        status: product.status
      }
    }]);

    console.log(`[AI Search] Synced product ID ${product.id} to Vector DB`);
  } catch (error) {
    console.error("[AI Search] Failed to sync product:", error);
  }
}

/**
 * Performs a Semantic AI Search
 */
async function performSemanticSearch(userQuery, limit = 10) {
  try {
    const index = pinecone.index(indexName);
    const queryEmbedding = await generateEmbedding(userQuery);

    const searchResults = await index.query({
      vector: queryEmbedding,
      topK: limit,
      includeMetadata: true,
      filter: { status: { $eq: 'active' } }
    });

    if (searchResults.matches.length === 0) return [];

    const productIds = searchResults.matches.map(match => match.id);

    const [rows] = await pool.query(
      `SELECT p.*, 
      (SELECT JSON_ARRAYAGG(file_path) FROM product_images WHERE product_id = p.id) as images
      FROM products p WHERE p.id IN (?)`,
      [productIds]
    );

    const sortedRows = productIds.map(id => rows.find(r => r.id.toString() === id)).filter(Boolean);
    
    return sortedRows;
  } catch (error) {
    console.error("[AI Search] Semantic search failed:", error);
    throw error;
  }
}

module.exports = {
  generateEmbedding,
  syncProductToVectorDB,
  performSemanticSearch
};
