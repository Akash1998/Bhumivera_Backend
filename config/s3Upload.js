// backend/config/s3Upload.js
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
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
async function generateUploadUrl(filename, fileType) {
  // Clean filename to prevent spaces/special chars from breaking URLs
  const cleanName = filename.replace(/[^a-zA-Z0-9.]/g, '-');
  const key = `products/${Date.now()}-${cleanName}`;
  
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: fileType,
  });
  
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
  return { uploadUrl, key };
}

module.exports = { s3, generateUploadUrl };
