// Popup: scan-on-open, the big number, fee preview, one-click reclaim.
// Claim flow: build unsigned txs here -> stash in session storage ->
// open the signer tab (a real https page where Phantom is injected) ->
// signer signs via Phantom, reports back through the background worker.

import { createRpc, DEFAULT_RPC_ENDPOINT } from '../lib/rpc.js';
import { scanWallet, formatSol, isPlausibleAddress } from '../lib/scan.js';
import { buildClaimTransactions, formatSolBigint } from '../lib/claim-tx.js';
import { api, API_BASE } from '../lib/api.js';

const SCAN_CACHE_MS = 10 * 60 * 1000;
const SIGN_URL = `${API_BASE}/sign`;

const $ = (id) => document.getElementById(id);
const els = {
  addr: $('addr'),
  scanBtn: $('scanBtn'),
  addrError: $('addrError'),
  loading: $('loading'),
  results: $('results'),
  totalSol: $('totalSol'),
  acctCount: $('acctCount'),
  deadSol: $('deadSol'),
  surplusSol: $('surplusSol'),
  scannedAt: $('scannedAt'),
  reclaimBtn: $('reclaimBtn'),
  feePreview: $('feePreview'),
  referrer: $('referrer'),
  refRow: $('refRow'),
  progress: $('progress'),
};

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function setError(msg) {
  if (!msg) { hide(els.addrError); els.addrError.textContent = ''; return; }
  els.addrError.textContent = msg;
  show(els.addrError);
}

let currentScan = null;
let currentConfig = null;
let currentClaimMeta = null; // { free, referrer }

async function runScan(owner, { force = false } = {}) {
  setError('');
  hide(els.results);
  hide(els.progress);
  show(els.loading);
  els.scanBtn.disabled = true;

  try {
    const cacheKey = `scan:${owner}`;
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    let result;
    if (!force && cached && Date.now() - cached.scannedAt < SCAN_CACHE_MS) {
      result = cached;
    } else {
      const { rpcEndpoint } = await chrome.storage.local.get('rpcEndpoint');
      const rpc = createRpc(rpcEndpoint || DEFAULT_RPC_ENDPOINT);
      result = await scanWallet(owner, rpc);
      await chrome.storage.local.set({ [cacheKey]: result, lastScan: result, owner });
    }
    currentScan = result;
    await render(result, owner);
  } catch (err) {
    setError(`scan failed: ${err.message}. try again in a bit.`);
  } finally {
    hide(els.loading);
    els.scanBtn.disabled = false;
  }
}

async function render(result, owner) {
  els.totalSol.textContent = formatSol(result.total);
  els.acctCount.textContent = result.deadCount + result.surplus.length;
  els.deadSol.textContent = `${formatSol(result.totalRecoverable)} SOL`;
  els.surplusSol.textContent = `${formatSol(result.totalSurplus)} SOL`;
  els.scannedAt.textContent =
    `scanned ${new Date(result.scannedAt).toLocaleTimeString()} · ${result.deadCount} dead, ${result.surplus.length} with excess`;
  show(els.results);

  chrome.runtime.sendMessage({ type: 'badge', total: result.total.toString() }).catch(() => {});

  // Fee preview + reclaim button state.
  const hasDead = result.deadCount > 0;
  els.reclaimBtn.disabled = !hasDead;
  if (!hasDead) {
    els.reclaimBtn.textContent = 'Nothing to reclaim';
    els.feePreview.textContent = '';
    hide(els.feePreview);
    return;
  }

  try {
    const [config, { count }, refInfo] = await Promise.all([
      api.config(),
      api.claimCount(owner),
      api.referralInfo(owner).catch(() => ({ referrer: null })),
    ]);
    currentConfig = config;
    const free = config.firstClaimFree && count === 0;
    const referrer = refInfo.referrer || null;
    currentClaimMeta = { free, referrer };

    const total = BigInt(result.totalRecoverable);
    show(els.feePreview);
    if (free) {
      els.feePreview.innerHTML = `your first cleanup is <b class="free">FREE</b> — you keep all ${formatSol(result.totalRecoverable)} SOL`;
      els.reclaimBtn.textContent = `Reclaim ${formatSol(result.totalRecoverable)} SOL — free`;
    } else {
      const fee = (total * BigInt(config.feeBps)) / 10000n;
      const youGet = total - fee;
      els.feePreview.innerHTML =
        `you get <b>${formatSolBigint(youGet)} SOL</b> · fee <b>${formatSolBigint(fee)} SOL</b> (${config.feeBps / 100}%)` +
        (referrer ? ` · referrer gets ${formatSolBigint((fee * BigInt(config.referrerBpsOfFee)) / 10000n)} of the fee` : '');
      els.reclaimBtn.textContent = `Reclaim ${formatSolBigint(youGet)} SOL`;
    }
    // Offer referral registration only if none is on file yet.
    if (!referrer) show(els.refRow); else hide(els.refRow);
  } catch (err) {
    els.feePreview.textContent = 'could not load fee info — reclaim still works, try again.';
    show(els.feePreview);
    currentClaimMeta = { free: false, referrer: null };
  }
}

els.scanBtn.addEventListener('click', () => {
  const owner = els.addr.value.trim();
  if (!isPlausibleAddress(owner)) {
    setError("that doesn't look like a Solana address — check it and try again.");
    return;
  }
  els.addr.value = owner;
  runScan(owner, { force: true });
});

els.addr.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.scanBtn.click();
});

els.reclaimBtn.addEventListener('click', async () => {
  if (!currentScan || currentScan.deadCount === 0 || !currentConfig) return;
  setError('');
  els.reclaimBtn.disabled = true;
  els.reclaimBtn.textContent = 'Preparing transactions…';

  try {
    const owner = els.addr.value.trim();
    const { free, referrer } = currentClaimMeta;

    // Fresh blockhash via our RPC proxy.
    const bhRes = await fetch(`${API_BASE}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] }),
    });
    const bhJson = await bhRes.json();
    const blockhash = bhJson.result?.value?.blockhash;
    if (!blockhash) throw new Error('could not get a recent blockhash');

    const txs = buildClaimTransactions({
      dead: currentScan.dead,
      owner,
      blockhash,
      feeWallet: currentConfig.feeWallet,
      feeBps: currentConfig.feeBps,
      referrer,
      referrerBpsOfFee: currentConfig.referrerBpsOfFee,
      free,
    });
    if (!txs.length) throw new Error('nothing to build');

    const referrerInput = els.referrer.value.trim();
    const referrerToRegister =
      !referrer && referrerInput && isPlausibleAddress(referrerInput) ? referrerInput : null;

    // Stash for the signer tab; it pulls via getClaimRequest.
    await chrome.storage.session.set({
      pendingClaim: {
        txs,
        owner,
        free,
        referrer,
        referrerToRegister,
        createdAt: Date.now(),
      },
    });

    await chrome.tabs.create({ url: `${SIGN_URL}#ext=${chrome.runtime.id}` });
    show(els.progress);
    els.progress.innerHTML = 'signer tab opened — approve in Phantom there. this popup will update when it’s done.';
  } catch (err) {
    setError(`couldn't prepare the claim: ${err.message}`);
    els.reclaimBtn.disabled = false;
    await render(currentScan, els.addr.value.trim());
  }
});

// Progress + completion events relayed by the background worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'claimProgress') {
    els.progress.innerHTML =
      `signed ${msg.done} of ${msg.total}… <span class="dim">${msg.signature.slice(0, 12)}…</span>`;
  } else if (msg.type === 'claimComplete') {
    els.progress.innerHTML = `<b class="free">done — SOL is back in your wallet.</b> rescanning…`;
    chrome.storage.session.remove('pendingClaim').catch(() => {});
    const owner = els.addr.value.trim();
    if (owner) runScan(owner, { force: true });
  } else if (msg.type === 'claimFailed') {
    setError(`claim failed: ${msg.error}`);
    hide(els.progress);
    els.reclaimBtn.disabled = false;
  }
});

// Scan-on-open: zero clicks to the number.
document.addEventListener('DOMContentLoaded', async () => {
  const { owner } = await chrome.storage.local.get('owner');
  if (owner) {
    els.addr.value = owner;
    runScan(owner);
  }
});
