'use strict';

/**
 * Bhumivera Veo 2 Video Service
 * -------------------------------------------------------------
 * Provides programmatic video generation using Google DeepMind's Veo 2
 * ('veo-2.0-generate-001') via @google/genai.
 *
 * Implements a strict sequential queue (CONCURRENCY = 1) to permanently
 * prevent hitting Google's limit of 3 concurrent video generation operations.
 */

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const DEFAULT_OUTPUT_DIR = path.resolve(
  __dirname,
  '../../Bhumivera_Frontend/public/videos/concierge'
);

const CONCIERGE_VIDEO_JOBS = [
  {
    id: 'facial_phase_1',
    category: 'Facial Ritual',
    title: 'Phase 01: Thermal Water Prep & Apothecary Dosing',
    fileName: 'facial_phase_1.mp4',
    prompt:
      'Ultra-luxury skincare commercial, macro close-up of clean hands under gentle lukewarm running water (28°C–32°C), glass apothecary bottle with gold pump, dispensing 1.5 pumps of rich amber botanical gel into damp palms, delicate rising steam, warm spa lighting, photorealistic 4k, 10 seconds slow motion.',
    aspectRatio: '16:9',
    durationSeconds: 10,
  },
  {
    id: 'facial_phase_2',
    category: 'Facial Ritual',
    title: 'Phase 02: Palm Micro-Foam Activation',
    fileName: 'facial_phase_2.mp4',
    prompt:
      'Extreme macro close-up of two wet palms vigorously rubbing together in brisk circular motion, aerating translucent golden gel into a dense, velvety, cloud-like white micro-cushion foam with micro-bubbles, zero friction, soft ambient glow, luxury beauty advertisement, 10 seconds slow motion.',
    aspectRatio: '16:9',
    durationSeconds: 10,
  },
  {
    id: 'facial_phase_3',
    category: 'Facial Ritual',
    title: 'Phase 03: 40s Zonal Ayurvedic Sculpt Massage & Phyto-Dwell',
    fileName: 'facial_phase_3.mp4',
    prompt:
      'Cinematic side profile of a serene woman gently massaging glowing botanical foam in slow upward lifting motions along jawline, cheeks, and nasal contours, golden translucent Ayurvedic botanical aura floating gently, warm studio lighting, 10 seconds.',
    aspectRatio: '16:9',
    durationSeconds: 10,
  },
  {
    id: 'facial_phase_4',
    category: 'Facial Ritual',
    title: 'Phase 04: Cool-Water Rinse & 60-Second Barrier Lock',
    fileName: 'facial_phase_4.mp4',
    prompt:
      'Slow-motion crystal-clear cool water splash gently rinsing face, soft pat with a clean plush towel leaving dew droplets, then hands warming pure golden Kumkumadi Night Elixir drops and pressing onto skin, luminous dewy barrier lock finish, 10 seconds.',
    aspectRatio: '16:9',
    durationSeconds: 10,
  },
  {
    id: 'botanical_sea_buckthorn',
    category: 'Botanical Library',
    title: 'Himalayan Sea Buckthorn & Omega-7 Active',
    fileName: 'botanical_sea_buckthorn.mp4',
    prompt:
      'Macro cinematic time-lapse of vibrant wild Himalayan sea buckthorn golden-orange berries covered in dew, morning sunlight, bursting with rich therapeutic omega-7 nectar, luxury nature documentary aesthetic, 10 seconds.',
    aspectRatio: '16:9',
    durationSeconds: 10,
  },
  {
    id: 'botanical_saffron',
    category: 'Botanical Library',
    title: 'Kashmiri Saffron Stigma Bloom',
    fileName: 'botanical_saffron.mp4',
    prompt:
      'Macro close-up of delicate purple Crocus sativus petals gently opening to reveal vivid red-gold Kashmiri saffron stigmas, warm golden sunbeam, ethereal Ayurvedic botanical essence, 10 seconds.',
    aspectRatio: '16:9',
    durationSeconds: 10,
  },
  {
    id: 'botanical_kumkumadi',
    category: 'Botanical Library',
    title: 'Kumkumadi Miraculous Night Elixir',
    fileName: 'botanical_kumkumadi.mp4',
    prompt:
      'Slow-motion golden botanical elixir droplet falling from a glass pipette into a pool of pure Ayurvedic botanical infusion, creating gentle ripple waves of amber light and saffron glow, 10 seconds.',
    aspectRatio: '16:9',
    durationSeconds: 10,
  },
  {
    id: 'botanical_charcoal',
    category: 'Botanical Library',
    title: 'Activated Bamboo Micro-Charcoal Detox',
    fileName: 'botanical_charcoal.mp4',
    prompt:
      'Cinematic macro shot of deep obsidian-black porous activated bamboo charcoal particles gently dissolving and purifying clean crystal water in slow motion, purifying detox visual, 10 seconds.',
    aspectRatio: '16:9',
    durationSeconds: 10,
  },
  {
    id: 'skin_quiz_diagnostic',
    category: 'Skin Quiz',
    title: 'Ayurvedic Biometric Skin Diagnostic',
    fileName: 'skin_quiz_diagnostic.mp4',
    prompt:
      'Aesthetic glowing biometric facial contour mapping, delicate golden Ayurvedic wave patterns tracing skin hydration levels and lipid barrier harmony, high-tech luxury skincare laboratory aesthetic, 10 seconds.',
    aspectRatio: '16:9',
    durationSeconds: 10,
  },
];

// In-memory queue state for active jobs
const queueState = {
  isProcessing: false,
  activeJobId: null,
  activeProgressSeconds: 0,
  jobHistory: {},
};

function resolveOutputDir() {
  return process.env.VEO_OUTPUT_DIR
    ? path.resolve(process.env.VEO_OUTPUT_DIR)
    : DEFAULT_OUTPUT_DIR;
}

function getRegisteredJobs() {
  const outputDir = resolveOutputDir();
  return CONCIERGE_VIDEO_JOBS.map(job => {
    const destPath = path.join(outputDir, job.fileName);
    const exists = fs.existsSync(destPath);
    let sizeBytes = 0;
    if (exists) {
      try {
        sizeBytes = fs.statSync(destPath).size;
      } catch {
        sizeBytes = 0;
      }
    }
    return {
      ...job,
      exists,
      sizeBytes,
      sizeMb: exists ? (sizeBytes / (1024 * 1024)).toFixed(2) : '0.00',
      status: queueState.jobHistory[job.id]?.status || (exists ? 'completed' : 'pending'),
      lastError: queueState.jobHistory[job.id]?.error || null,
    };
  });
}

async function downloadVideoPayload(uriOrBytes, destinationPath) {
  if (typeof uriOrBytes === 'string' && uriOrBytes.startsWith('http')) {
    const res = await fetch(uriOrBytes);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching video from ${uriOrBytes}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destinationPath, buffer);
  } else if (Buffer.isBuffer(uriOrBytes)) {
    fs.writeFileSync(destinationPath, uriOrBytes);
  } else if (typeof uriOrBytes === 'string') {
    const buffer = Buffer.from(uriOrBytes, 'base64');
    fs.writeFileSync(destinationPath, buffer);
  } else {
    throw new Error('Unsupported video payload format returned by Veo');
  }
}

async function executeVeoJob(job, { apiKey, outputDir = resolveOutputDir() } = {}) {
  const resolvedKey = apiKey || process.env.GEMINI_API_KEY?.trim();
  if (!resolvedKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const ai = new GoogleGenAI({ apiKey: resolvedKey });
  fs.mkdirSync(outputDir, { recursive: true });
  const destPath = path.join(outputDir, job.fileName);

  queueState.activeJobId = job.id;
  queueState.activeProgressSeconds = 0;
  queueState.jobHistory[job.id] = { status: 'rendering', startTime: Date.now() };

  console.log(`[VEO SERVICE] Starting job: ${job.id} (${job.title})...`);

  let operation;
  try {
    operation = await ai.models.generateVideos({
      model: 'veo-2.0-generate-001',
      source: { prompt: job.prompt },
      config: {
        numberOfVideos: 1,
        aspectRatio: job.aspectRatio || '16:9',
        durationSeconds: job.durationSeconds || 10,
        resolution: '1080p',
      },
    });
  } catch (err) {
    queueState.jobHistory[job.id] = { status: 'failed', error: err.message };
    throw err;
  }

  const startTime = Date.now();
  while (!operation.done) {
    await new Promise(r => setTimeout(r, 10000));
    queueState.activeProgressSeconds = Math.round((Date.now() - startTime) / 1000);
    try {
      operation = await ai.operations.getVideosOperation({ operation });
    } catch (pollErr) {
      console.warn(`[VEO SERVICE] Poll warning for ${job.id}:`, pollErr.message);
    }
  }

  const generatedVideo = operation.response?.generatedVideos?.[0];
  const videoUri = generatedVideo?.video?.uri || generatedVideo?.video?.videoBytes;

  if (!videoUri) {
    const err = new Error(`Veo finished but returned no video URI: ${JSON.stringify(operation.response || {})}`);
    queueState.jobHistory[job.id] = { status: 'failed', error: err.message };
    throw err;
  }

  await downloadVideoPayload(videoUri, destPath);

  queueState.jobHistory[job.id] = {
    status: 'completed',
    completedAt: Date.now(),
    durationSeconds: Math.round((Date.now() - startTime) / 1000),
  };
  queueState.activeJobId = null;

  console.log(`[VEO SERVICE] Completed ${job.id} -> ${destPath}`);
  return { success: true, filePath: destPath, fileName: job.fileName };
}

/**
 * Background auto-provisioner:
 * Automatically checks whether any concierge video MP4s are missing from disk.
 * If missing, it initiates background generation 1-by-1 without blocking the server.
 */
function autoProvisionMissingVideos({ delayMs = 6000 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.log('[VEO AUTO-PROVISION] Skipped: GEMINI_API_KEY is not configured in .env.');
    return;
  }

  if (process.env.AUTO_GENERATE_VEO_VIDEOS === 'false') {
    console.log('[VEO AUTO-PROVISION] Skipped: AUTO_GENERATE_VEO_VIDEOS is disabled.');
    return;
  }

  const timer = setTimeout(async () => {
    try {
      const jobs = getRegisteredJobs();
      const missing = jobs.filter(j => !j.exists);
      if (missing.length === 0) {
        console.log('[VEO AUTO-PROVISION] All 9 concierge video clips exist on disk. Zero generation needed.');
        return;
      }

      console.log(`[VEO AUTO-PROVISION] Found ${missing.length} missing concierge video(s). Auto-generating in background (1-by-1 queue)...`);
      queueState.isProcessing = true;

      for (let i = 0; i < missing.length; i++) {
        const job = missing[i];
        console.log(`[VEO AUTO-PROVISION] Auto-generating (${i + 1}/${missing.length}): ${job.id}...`);
        try {
          await executeVeoJob(job, { apiKey });
          if (i < missing.length - 1) {
            await new Promise(r => setTimeout(r, 5000));
          }
        } catch (jobErr) {
          console.error(`[VEO AUTO-PROVISION] Failed job ${job.id}:`, jobErr.message);
        }
      }
      queueState.isProcessing = false;
      console.log('[VEO AUTO-PROVISION] Background auto-provisioning run finished.');
    } catch (err) {
      queueState.isProcessing = false;
      console.error('[VEO AUTO-PROVISION ERROR]:', err.message);
    }
  }, delayMs);

  timer.unref();
}

module.exports = {
  CONCIERGE_VIDEO_JOBS,
  getRegisteredJobs,
  executeVeoJob,
  autoProvisionMissingVideos,
  resolveOutputDir,
  queueState,
};

