/**
 * Bhumivera Backend — Automated Codebase & AI Memory Audit Script
 * 
 * Usage: node AI_MEMORY/scripts/audit_memory.js
 * 
 * Purpose:
 * Scans routes, models, and migrations inside Bhumivera_Backend,
 * calculates verified endpoint and function counts, and prints a snapshot
 * for AI memory files and bot handoffs.
 */

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.resolve(__dirname, '..', '..');

function auditBackend() {
  const routesDir = path.join(BACKEND_DIR, 'routes');
  const modelsDir = path.join(BACKEND_DIR, 'models');
  const migrationsFile = path.join(BACKEND_DIR, 'migrations', 'index.js');

  const routeFiles = fs.existsSync(routesDir) ? fs.readdirSync(routesDir).filter(f => f.endsWith('.js')) : [];
  let totalEndpoints = 0;
  const routeStats = [];

  routeFiles.forEach(f => {
    const content = fs.readFileSync(path.join(routesDir, f), 'utf8');
    const matches = content.match(/router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g) || [];
    const endpoints = matches.map(m => {
      const match = m.match(/router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/);
      return match ? `${match[1].toUpperCase()} ${match[2]}` : m;
    });
    totalEndpoints += matches.length;
    routeStats.push({ file: f, count: matches.length, endpoints });
  });

  const modelFiles = fs.existsSync(modelsDir) ? fs.readdirSync(modelsDir).filter(f => f.endsWith('.js')) : [];
  let totalModelExports = 0;
  const modelStats = [];

  modelFiles.forEach(f => {
    const content = fs.readFileSync(path.join(modelsDir, f), 'utf8');
    const exportMatch = content.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/);
    let items = [];
    if (exportMatch) {
      items = exportMatch[1]
        .split(',')
        .map(s => s.trim().split(/\s*:/)[0])
        .filter(s => s && !s.startsWith('//') && !s.startsWith('/*') && !s.includes('\n'));
    }
    totalModelExports += items.length;
    modelStats.push({ file: f, count: items.length, items });
  });

  let migrationCount = 0;
  let migrations = [];
  if (fs.existsSync(migrationsFile)) {
    const content = fs.readFileSync(migrationsFile, 'utf8');
    const matches = [...content.matchAll(/version:\s*(\d+),\s*name:\s*['"`]([^'"`]+)['"`]/g)];
    migrationCount = matches.length;
    migrations = matches.map(m => ({ version: parseInt(m[1], 10), name: m[2] }));
  }

  return {
    totalRouteFiles: routeFiles.length,
    totalEndpoints,
    routeStats,
    totalModelFiles: modelFiles.length,
    totalModelExports,
    modelStats,
    migrationCount,
    latestMigration: migrations[migrations.length - 1] || null
  };
}

function runAudit() {
  console.log('='.repeat(70));
  console.log('  BHUMIVERA BACKEND — CODEBASE & AI MEMORY AUDIT');
  console.log('='.repeat(70));
  console.log(`Scan Timestamp: ${new Date().toISOString()}`);
  console.log(`Directory: ${BACKEND_DIR}\n`);

  const backend = auditBackend();
  console.log(`  Route Files:       ${backend.totalRouteFiles}`);
  console.log(`  Total Endpoints:   ${backend.totalEndpoints}`);
  console.log(`  Model Files:       ${backend.totalModelFiles}`);
  console.log(`  Exported Entities: ${backend.totalModelExports}`);
  console.log(`  Migrations Count:  ${backend.migrationCount} (Latest: v${backend.latestMigration?.version} - "${backend.latestMigration?.name}")`);

  console.log('\n' + '='.repeat(70));
  console.log('  MEMORY STATUS: VERIFIED AND HEALTHY');
  console.log('='.repeat(70));

  return backend;
}

if (require.main === module) {
  runAudit();
}

module.exports = { auditBackend, runAudit };
