// backend/config/s3Upload.js
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// 1) R2 (S3-Compatible) Client Setup
const s3 = new S3Client({
  region: process.env.R2_REGION || "auto",
  endpoint: process.env.R2_ENDPOINT, 
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

// 2) Generate a secure URL for the frontend to upload directly to R2
async function generateUploadUrl(filename, fileType, prefix = "products", contentLength) {
  const cleanName = filename.replace(/[^a-zA-Z0-9.]/g, '-');
  const key = `${prefix}/${Date.now()}-${require("crypto").randomBytes(8).toString("hex")}-${cleanName}`;
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY || !process.env.R2_SECRET_KEY || !process.env.R2_BUCKET_NAME) {
    throw new Error('Object storage uploads are not configured.');
  }
  
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: fileType,
    ...(contentLength ? { ContentLength: contentLength } : {}),
  });
  
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
  return { uploadUrl, key };
}

async function deleteProductImage(key) {
  if (!key.startsWith('products/')) throw new Error('Invalid product image key.');
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY || !process.env.R2_SECRET_KEY || !process.env.R2_BUCKET_NAME) {
    throw new Error('Object storage deletion is not configured.');
  }
  await s3.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  }));
}

async function deleteReviewImage(key) {
  if (!key.startsWith('reviews/')) throw new Error('Invalid review image key.');
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY || !process.env.R2_SECRET_KEY || !process.env.R2_BUCKET_NAME) {
    throw new Error('Object storage deletion is not configured.');
  }
  await s3.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  }));
}

module.exports = { s3, generateUploadUrl, deleteProductImage, deleteReviewImage };
