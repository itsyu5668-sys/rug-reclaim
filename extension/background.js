// Service worker: background rescan every 6h, toolbar badge, threshold alerts.
// This is the habit engine — the badge ticking up as the user trades is the
// re-engagement loop. Never touches web pages; talks only to the RPC endpoint.

import { createRpc, DEFAULT_RPC_ENDPOINT } from './lib/rpc.js';
import { scanWallet, shortSol, formatSol } from './lib/scan.js';

const RESCAN_PERIOD_MIN = 360; // 6h
const DEFAULT_THRESHOLD_SOL = 0.05;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create('rescan', { periodInMinutes: RESCAN_PERIOD_MIN });
  const { thresholdSol } = await chrome.storage.local.get('thresholdSol');
  if (thresholdSol === undefined) {
    await chrome.storage.local.set({ thresholdSol: DEFAULT_THRESHOLD_SOL });
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('rescan', { periodInMinutes: RESCAN_PERIOD_MIN });
});

// Popup asks the worker to refresh the badge after a scan (popup can't touch
// the action badge reliably from a module context on all Chrome versions).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'badge' && typeof msg.total === 'string') {
    updateBadge(BigInt(msg.total));
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {  if (alarm.name !== 'rescan') return;
  const { owner, rpcEndpoint } = await chrome.storage.local.get(['owner', 'rpcEndpoint']);
  if (!owner) return; // nothing watched yet

  try {
    const rpc = createRpc(rpcEndpoint || DEFAULT_RPC_ENDPOINT);
    const result = await scanWallet(owner, rpc);
    await chrome.storage.local.set({ lastScan: result });
    await updateBadge(result.total);
    await maybeNotify(result.total);
  } catch (err) {
    // RPC hiccup — stay quiet, next alarm retries. Never nag the user about infra.
    console.warn('[rug-reclaim] background rescan failed:', err.message);
  }
});

async function updateBadge(totalLamports) {
  const text = shortSol(totalLamports);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
  await chrome.action.setTitle({
    title: totalLamports > 0n ? `${formatSol(totalLamports)} SOL trapped — open to reclaim` : 'Rug Reclaim',
  });
}

async function maybeNotify(totalLamports) {
  const { thresholdSol, lastNotifiedTotal } = await chrome.storage.local.get([
    'thresholdSol',
    'lastNotifiedTotal',
  ]);
  const threshold = BigInt(Math.round((thresholdSol ?? DEFAULT_THRESHOLD_SOL) * 1e9));
  const prev = BigInt(lastNotifiedTotal ?? 0);

  // Fire only on upward crossing — every alert is a revenue event, so tune the
  // threshold (default 0.05 SOL) to fire ~monthly per user, never spam.
  if (totalLamports >= threshold && prev < threshold) {
    await chrome.notifications.create('threshold-crossed', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'SOL waiting to be reclaimed',
      message: `You've got ${formatSol(totalLamports)} SOL trapped in dead accounts. One click to take it back.`,
    });
    await chrome.storage.local.set({ lastNotifiedTotal: totalLamports.toString() });
  } else if (totalLamports < prev) {
    // Balance dropped (they cleaned up) — reset so the next build-up re-alerts.
    await chrome.storage.local.set({ lastNotifiedTotal: totalLamports.toString() });
  }
}
