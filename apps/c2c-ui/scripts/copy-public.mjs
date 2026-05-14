#!/usr/bin/env node
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');
const distDir = resolve(here, '..', 'dist');

mkdirSync(distDir, { recursive: true });

if (!existsSync(publicDir)) {
  console.error(`[c2c-ui] public dir not found at ${publicDir}`);
  process.exit(1);
}

cpSync(publicDir, distDir, { recursive: true, force: true });

// rewrite the script path so the HTML can be loaded directly from dist/
// (no extra step needed because the HTML already references ./main.js
// and tsc emits dist/main.js next to dist/index.html)

console.log(`[c2c-ui] copied static assets from ${publicDir} -> ${distDir}`);
