const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { describe, it } = require('node:test');

const s3UploadPath = path.resolve(__dirname, '../config/s3Upload.js');
const originalLoad = Module._load;
const uploadedCommands = [];

Module._load = function (request, parent, isMain) {
  if (parent?.filename === s3UploadPath && request === '@aws-sdk/client-s3') {
    return {
      S3Client: class S3Client {},
      PutObjectCommand: class PutObjectCommand {
        constructor(input) {
          this.input = input;
          uploadedCommands.push(input);
        }
      },
      DeleteObjectCommand: class DeleteObjectCommand {},
    };
  }
  if (parent?.filename === s3UploadPath && request === '@aws-sdk/s3-request-presigner') {
    return { getSignedUrl: async () => 'https://storage.example/upload' };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { generateUploadUrl } = require('../config/s3Upload');
Module._load = originalLoad;

describe('product image upload caching', () => {
  it('stores public product images with immutable cache metadata', async () => {
    const previousEnv = {
      R2_ENDPOINT: process.env.R2_ENDPOINT,
      R2_ACCESS_KEY: process.env.R2_ACCESS_KEY,
      R2_SECRET_KEY: process.env.R2_SECRET_KEY,
      R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
    };
    process.env.R2_ENDPOINT = 'https://storage.example';
    process.env.R2_ACCESS_KEY = 'test-key';
    process.env.R2_SECRET_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'test-bucket';
    try {
      await generateUploadUrl('product.webp', 'image/webp', 'products', 1024);
      assert.equal(uploadedCommands.at(-1).CacheControl, 'public, max-age=31536000, immutable');
      assert.equal(uploadedCommands.at(-1).ContentLength, 1024);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('does not make return evidence photos publicly cacheable', async () => {
    const previousEnv = {
      R2_ENDPOINT: process.env.R2_ENDPOINT,
      R2_ACCESS_KEY: process.env.R2_ACCESS_KEY,
      R2_SECRET_KEY: process.env.R2_SECRET_KEY,
      R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
    };
    process.env.R2_ENDPOINT = 'https://storage.example';
    process.env.R2_ACCESS_KEY = 'test-key';
    process.env.R2_SECRET_KEY = 'test-secret';
    process.env.R2_BUCKET_NAME = 'test-bucket';
    try {
      await generateUploadUrl('evidence.webp', 'image/webp', 'returns/7', 1024);
      assert.equal(uploadedCommands.at(-1).CacheControl, undefined);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
