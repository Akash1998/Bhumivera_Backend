const pool = require('../config/db');

const indexName = 'Bhumivera-products';
let pinecone = null;
function getPinecone() {
  if (pinecone) return pinecone;
  try {
    if (process.env.PINECONE_API_KEY) {
      const { Pinecone } = require('@pinecone-database/pinecone');
      pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    }
  } catch (e) {
    console.warn('[vectorService] Pinecone init skipped:', e.message);
    pinecone = null;
  }
  return pinecone;
}

// Singleton pattern to load the AI model once in memory
let extractorPromise;

// Cache the promise so concurrent first calls don't each load a separate copy of the model.
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import('@huggingface/transformers')
      .then(({ pipeline }) => pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'))
      .catch(err => {
        extractorPromise = null;
        throw err;
      });
  }
  return extractorPromise;
}

const HF_EMBED_URL = 'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction';

// Same all-MiniLM-L6-v2 model, hosted: identical vectors to the local model, without ~150MB+ of RAM.
async function generateRemoteEmbedding(text) {
  const res = await fetch(HF_EMBED_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HF embedding failed: ${res.status}`);
  let vec = await res.json();
  if (Array.isArray(vec[0])) vec = vec[0];
  if (vec.length !== 384) throw new Error('HF embedding returned unexpected shape');
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

/**
 * Generates an embedding vector (hosted when HF_TOKEN is set, otherwise local)
 */
async function generateEmbedding(text) {
  if (process.env.HF_TOKEN) {
    try {
      return await generateRemoteEmbedding(text);
    } catch (e) {
      console.warn('[vectorService] Hosted embedding failed, using local model:', e.message);
    }
  }
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
    const pc = getPinecone();
    if (!pc) { console.warn('[AI Search] Pinecone not configured, sync skipped'); return; }
    const index = pc.index(indexName);
    
    const contentToEmbed = `
      Product: ${product.name}
      Category: ${product.category_id}
      Brand: ${product.brand || 'Bhumivera'}
      Description: ${product.description}
      Tags: ${product.tags || ''}
      Specifications: ${product.specifications || ''}
    `.trim();

    const embedding = await generateEmbedding(contentToEmbed);

    await index.upsert({
      records: [{
        id: product.id.toString(),
        values: embedding,
        metadata: {
          name: product.name,
          category_id: product.category_id,
          price: product.price,
          status: product.status
        }
      }]
    });

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
    const pc = getPinecone();
    if (!pc) { console.warn('[AI Search] Pinecone not configured, search skipped'); return []; }
    const index = pc.index(indexName);
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
