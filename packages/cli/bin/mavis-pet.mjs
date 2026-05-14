#!/usr/bin/env node
// Thin wrapper so `npm i -g` exposes `mavis-pet` while the actual logic
// lives in dist/cli.js (after `npm run build`).
import('../dist/cli.js').catch((err) => {
  console.error('mavis-pet: failed to load dist/cli.js — did you run `npm run build`?');
  console.error(err);
  process.exit(1);
});
