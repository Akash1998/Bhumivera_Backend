/**
 * Bhumivera Veo 2 Concierge Video Generator
 * -------------------------------------------------------------
 * Automated batch generator for 10-second AI visual presentation clips
 * using Google DeepMind's Veo 2 ('veo-2.0-generate-001') via @google/genai.
 *
 * Designed to strictly adhere to the API limit of max 3 concurrent video jobs
 * by enforcing a strict sequential queue (CONCURRENCY = 1).
 *
 * Generated MP4 clips are written directly to:
 * Bhumivera_Frontend/public/videos/concierge/
 */

'use strict';

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const DEFAULT_OUTPUT_DIR = path.resolve(
  __dirname,
  '../../Bhumivera_Frontend/public/videos/concierge'
);

const JOBS = [
  // --- FACIAL RITUAL 4 PHASES ---
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

  // --- BOTANICAL LIBRARY HEROES ---
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

  // --- SKIN QUIZ DIAGNOSTIC ---
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

function printUsage() {
  console.log(`
Bhumivera Veo 2 Concierge Video Generator
Usage:
  node scripts/generateConciergeVeoVideos.js [options]

Options:
  --all             Generate all video clips in sequence (Queue mode, strictly 1-by-1)
  --job <id>        Generate a specific video by job ID
  --list            List all available video jobs and their output files
  --dry-run         Verify configuration, output directories, and prompt details without API calls
  --output <dir>    Specify custom destination directory for MP4 files
  --help            Show this help guide

Available Job IDs:
${JOBS.map(j => `  - ${j.id.padEnd(25)} [${j.category}] ${j.title}`).join('\n')}
`);
}

async function downloadVideo(uriOrBytes, destinationPath) {
  if (typeof uriOrBytes === 'string' && uriOrBytes.startsWith('http')) {
    const res = await fetch(uriOrBytes);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching video from ${uriOrBytes}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destinationPath, buffer);
  } else if (Buffer.isBuffer(uriOrBytes)) {
    fs.writeFileSync(destinationPath, uriOrBytes);
  } else if (typeof uriOrBytes === 'string') {
    // Base64
    const buffer = Buffer.from(uriOrBytes, 'base64');
    fs.writeFileSync(destinationPath, buffer);
  } else {
    throw new Error('Unsupported video format in Veo response payload');
  }
}

async function processJob(job, ai, outputDir, dryRun = false) {
  const destPath = path.join(outputDir, job.fileName);
  console.log('\n============================================================');
  console.log(`🎬 JOB: [${job.id}] ${job.title}`);
  console.log(`📁 Target File: ${destPath}`);
  console.log(`📐 Aspect: ${job.aspectRatio} | Duration: ${job.durationSeconds}s`);
  console.log(`📝 Prompt: "${job.prompt}"`);
  console.log('============================================================');

  if (dryRun) {
    console.log(`[DRY-RUN] Verified job configuration. Skipping API generation.`);
    return true;
  }

  console.log(`🚀 Dispatching Veo 2 generation request...`);
  const startTime = Date.now();

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
    console.error(`❌ Failed to initiate Veo generation:`, err.message);
    throw err;
  }

  // Poll strictly 1-by-1 to stay well within the max-3 concurrency limit
  let pollCount = 0;
  while (!operation.done) {
    pollCount++;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`⏳ Veo is rendering ${job.id}... (${elapsed}s elapsed, poll #${pollCount})\r`);
    await new Promise(r => setTimeout(r, 10000));

    try {
      operation = await ai.operations.getVideosOperation({ operation });
    } catch (pollErr) {
      console.warn(`\n⚠️ Warning during poll attempt: ${pollErr.message}. Retrying...`);
    }
  }

  console.log(`\n✨ Veo finished rendering ${job.id} in ${Math.round((Date.now() - startTime) / 1000)}s!`);

  const generatedVideo = operation.response?.generatedVideos?.[0];
  const videoUri = generatedVideo?.video?.uri || generatedVideo?.video?.videoBytes;

  if (!videoUri) {
    throw new Error(`Veo completed but returned no video URI or bytes: ${JSON.stringify(operation.response || {})}`);
  }

  console.log(`📥 Downloading video stream to ${job.fileName}...`);
  await downloadVideo(videoUri, destPath);

  const stats = fs.statSync(destPath);
  console.log(`✅ Saved ${job.fileName} (${(stats.size / (1024 * 1024)).toFixed(2)} MB) to disk!`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    printUsage();
    return;
  }

  if (args.includes('--list')) {
    console.log('\n--- Registered Concierge Video Jobs ---');
    JOBS.forEach((j, idx) => {
      console.log(`${idx + 1}. [${j.id}] ${j.title} -> ${j.fileName}`);
    });
    return;
  }

  const dryRun = args.includes('--dry-run');

  let outputDir = DEFAULT_OUTPUT_DIR;
  const outIdx = args.indexOf('--output');
  if (outIdx !== -1 && args[outIdx + 1]) {
    outputDir = path.resolve(process.cwd(), args[outIdx + 1]);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`📁 Video output directory: ${outputDir}`);

  let apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey && !dryRun) {
    console.error('❌ Error: GEMINI_API_KEY is not set in process.env or .env file.');
    console.error('   Please add GEMINI_API_KEY to Bhumivera_Backend/.env or run with --dry-run to test.');
    process.exit(1);
  }

  const ai = dryRun ? null : new GoogleGenAI({ apiKey });

  let jobsToRun = [];
  const jobIdx = args.indexOf('--job');
  if (jobIdx !== -1 && args[jobIdx + 1]) {
    const targetId = args[jobIdx + 1].trim();
    const found = JOBS.find(j => j.id.toLowerCase() === targetId.toLowerCase());
    if (!found) {
      console.error(`❌ Unknown job ID "${targetId}". Use --list to see available jobs.`);
      process.exit(1);
    }
    jobsToRun.push(found);
  } else if (args.includes('--all')) {
    jobsToRun = JOBS;
  } else {
    console.error('❌ Please specify --all or --job <id>. Run with --help for details.');
    process.exit(1);
  }

  console.log(`\n📋 Queue loaded: ${jobsToRun.length} video(s) to process sequentially.`);
  console.log(`🔒 Concurrency mode: 1 (Ensures API concurrency limit of 3 is NEVER exceeded).`);

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < jobsToRun.length; i++) {
    const currentJob = jobsToRun[i];
    console.log(`\n[Queue Progress: ${i + 1} of ${jobsToRun.length}]`);
    try {
      await processJob(currentJob, ai, outputDir, dryRun);
      succeeded++;
      // Polite 5s delay between generations to avoid rapid-fire burst requests
      if (!dryRun && i < jobsToRun.length - 1) {
        console.log('⏳ Cooling down for 5 seconds before next video generation...');
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (err) {
      failed++;
      console.error(`❌ Error processing job ${currentJob.id}:`, err.message);
    }
  }

  console.log('\n============================================================');
  console.log(`🏁 Batch Veo Run Completed: ${succeeded} succeeded, ${failed} failed.`);
  console.log('============================================================');
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
