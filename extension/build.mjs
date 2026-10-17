// Build the extension bundles with esbuild (MV3 forbids remote code,
// so everything must be bundled locally).
//
// Outputs:
//   popup/popup.bundle.js            — popup UI + tx building (@solana/web3.js)
//   ../worker/src/static/signer.bundle.js — signer tab (@phantom/browser-sdk + web3.js)

import { build } from 'esbuild';
import { mkdirSync } from 'fs';

mkdirSync('../worker/src/static', { recursive: true });

const shared = {
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
};

await build({
  ...shared,
  entryPoints: ['popup/popup.js'],
  outfile: 'popup/popup.bundle.js',
});

await build({
  ...shared,
  entryPoints: ['src/signer.js'],
  outfile: '../worker/src/static/signer.bundle.txt',
});

console.log('bundles built');
