#!/usr/bin/env node
// Fails if any first-load chunk for any production-shipping route imports
// Monaco. Monaco must only appear in lazy-loaded chunks reached through
// next/dynamic. Reads `.next/diagnostics/route-bundle-stats.json`, which Next.js
// produces during `next build` with Turbopack.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(scriptDir, "..");
const nextDir = join(studioRoot, ".next");
const statsPath = join(nextDir, "diagnostics", "route-bundle-stats.json");

if (!existsSync(statsPath)) {
  console.error(
    `Build diagnostics not found at ${statsPath}. Run \`npm run build\` first.`,
  );
  process.exit(1);
}

const stats = JSON.parse(readFileSync(statsPath, "utf8"));
if (!Array.isArray(stats)) {
  console.error(
    `Unexpected shape in ${statsPath}: expected an array of route stats.`,
  );
  process.exit(1);
}

// Match the actual Monaco runtime — path-shaped references that only the
// bundled module would contain. Bare-substring matches on "monaco-editor"
// would false-positive on incidental mentions (e.g., license headers,
// source-map paths, or other packages that name-drop Monaco in comments).
const monacoMarkers = [
  /\bmonaco-editor\/esm\//,
  /\bmonaco-editor\/min\//,
  /\bnode_modules\/monaco-editor\//,
  /\b@monaco-editor\/react\//,
  /["']monaco-editor["']/,
  /["']@monaco-editor\/react["']/,
];

function matchesAnyMarker(content) {
  for (const marker of monacoMarkers) {
    if (marker.test(content)) {
      return marker.source;
    }
  }
  return null;
}

const offenders = [];
const inspected = new Set();

for (const route of stats) {
  const chunks = Array.isArray(route?.firstLoadChunkPaths)
    ? route.firstLoadChunkPaths
    : [];
  for (const chunk of chunks) {
    const abs = resolve(studioRoot, chunk);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      continue;
    }
    inspected.add(abs);
    const content = readFileSync(abs, "utf8");
    const matched = matchesAnyMarker(content);
    if (matched) {
      offenders.push({ route: route.route, chunk, marker: matched });
    }
  }
}

if (offenders.length > 0) {
  console.error(
    "Monaco is statically reachable from a first-load chunk. Offending entries:",
  );
  for (const { route, chunk, marker } of offenders) {
    console.error(`  route=${route}  chunk=${chunk}  matched=${marker}`);
  }
  process.exit(1);
}

const monacoLazyChunks = findMonacoLazyChunks(nextDir, inspected);
if (monacoLazyChunks.length === 0) {
  console.error(
    "No chunk references Monaco at all. Expected at least one lazy chunk to contain Monaco.",
  );
  process.exit(1);
}

console.log(
  `OK: Monaco is absent from every first-load chunk across ${stats.length} route(s); found in ${monacoLazyChunks.length} lazy chunk(s).`,
);

function findMonacoLazyChunks(rootDir, firstLoadSet) {
  const chunksDir = join(rootDir, "static", "chunks");
  if (!existsSync(chunksDir)) {
    return [];
  }
  const lazyChunks = [];
  for (const entry of walk(chunksDir)) {
    if (!entry.endsWith(".js")) {
      continue;
    }
    if (firstLoadSet.has(entry)) {
      continue;
    }
    const content = readFileSync(entry, "utf8");
    if (matchesAnyMarker(content)) {
      lazyChunks.push(entry);
    }
  }
  return lazyChunks;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}
