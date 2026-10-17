// Service worker: background rescan every 6h, toolbar badge, threshold alerts.
// This is the habit engine — the badge ticking up as the user trades is the
// re-engagement loop. Never touches web pages; talks only to the RPC endpoint.

import { createRpc, DEFAULT_RPC_ENDPOINT } from './lib/rpc.js';
import { scanWallet, shortSol, formatSol, formatSolExact } from './lib/scan.js';
import { api } from './lib/api.js';
import { saveScan, getWallets } from './lib/store.js';

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

// --- Signer-tab bridge ------------------------------------------------------
// The signer tab is a real https:// page (served by our backend) where Phantom
// injects its provider. It talks to us via externally_connectable messaging.
// The pending claim is stashed by the popup in session storage (10-min TTL).

const PENDING_TTL_MS = 10 * 60 * 1000;

async function getPendingClaim() {
  const { pendingClaim } = await chrome.storage.session.get('pendingClaim');
  if (!pendingClaim) return null;
  if (Date.now() - pendingClaim.createdAt > PENDING_TTL_MS) {
    await chrome.storage.session.remove('pendingClaim');
    return null;
  }
  return pendingClaim;
}

function relayToPopup(msg) {
  // Popup may be closed — that's fine, the signer tab shows its own status.
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'getClaimRequest') {
      const claim = await getPendingClaim();
      sendResponse(
        claim
          ? {
              txs: claim.txs,
              owner: claim.owner,
              referrerToRegister: claim.referrerToRegister || null,
            }
          : null,
      );
      return;
    }

    if (msg.type === 'registerReferral') {
      try {
        await api.registerReferral(msg.body);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    if (msg.type === 'claimProgress') {
      relayToPopup({ type: 'claimProgress', done: msg.done, total: msg.total, signature: msg.signature });
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'claimComplete') {
      const claim = await getPendingClaim();
      if (claim) {
        // Log each confirmed tx to the backend (drives first-claim-free + stats).
        for (let i = 0; i < claim.txs.length; i++) {
          const t = claim.txs[i];
          try {
            await api.logClaim({
              wallet: claim.owner,
              txSignature: msg.signatures[i] || `unknown-${i}`,
              accountsClosed: t.accountsClosed,
              lamportsReclaimed: t.lamportsReclaimed,
              feeLamports: t.feeLamports,
              referrerFeeLamports: t.referrerFeeLamports,
              referrer: claim.referrer || null,
            });
          } catch (err) {
            console.warn('[rug-reclaim] claim logging failed:', err.message);
          }
        }
        await chrome.storage.session.remove('pendingClaim');
      }
      relayToPopup({ type: 'claimComplete' });
      // Refresh the badge — the trapped amount should now be ~0.
      try {
        const { rpcEndpoint } = await chrome.storage.local.get('rpcEndpoint');
        const rpc = createRpc(rpcEndpoint || DEFAULT_RPC_ENDPOINT);
        const result = await scanWallet(claim.owner, rpc);
        await saveScan(claim.owner, result);
        const wallets = await getWallets();
        let grand = 0n;
        for (const w of wallets) {
          const r = await scanWallet(w, rpc);
          grand += r.total;
        }
        await updateBadge(grand);
      } catch {}
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'claimFailed') {
      relayToPopup({ type: 'claimFailed', error: msg.error });
      sendResponse({ ok: true });
      return;
    }
  })();
  return true; // async response
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'rescan') return;
  const wallets = await getWallets();
  if (!wallets.length) return; // nothing watched yet

  try {
    const { rpcEndpoint } = await chrome.storage.local.get('rpcEndpoint');
    const rpc = createRpc(rpcEndpoint || DEFAULT_RPC_ENDPOINT);
    let grand = 0n;
    for (const w of wallets) {
      const result = await scanWallet(w, rpc);
      await saveScan(w, result);
      grand += result.total;
    }
    await updateBadge(grand);
    await maybeNotify(grand);
  } catch (err) {
    // RPC hiccup — stay quiet, next alarm retries. Never nag the user about infra.
    console.warn('[sol-burn] background rescan failed:', err.message);
  }
});

async function updateBadge(totalLamports) {
  if (typeof totalLamports !== 'bigint') return;
  const text = shortSol(totalLamports);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
  await chrome.action.setTitle({
    title:
      totalLamports > 0n
        ? `${formatSolExact(totalLamports)} SOL trapped across your wallets, open to reclaim`
        : 'Sol Burn',
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
