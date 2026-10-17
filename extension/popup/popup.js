// Popup: scan-on-open, the big number, breakdown. Read-only —
// the claim flow (Phantom connect + batch close + in-tx fee) is step 2.

import { createRpc, DEFAULT_RPC_ENDPOINT } from '../lib/rpc.js';
import { scanWallet, formatSol, isPlausibleAddress } from '../lib/scan.js';

const SCAN_CACHE_MS = 10 * 60 * 1000;

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
};

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function setError(msg) {
  if (!msg) { hide(els.addrError); els.addrError.textContent = ''; return; }
  els.addrError.textContent = msg;
  show(els.addrError);
}

async function runScan(owner, { force = false } = {}) {
  setError('');
  hide(els.results);
  show(els.loading);
  els.scanBtn.disabled = true;

  try {
    // Serve from cache unless forced or stale — scans are RPC-heavy.
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
    render(result);
  } catch (err) {
    setError(`scan failed: ${err.message}. try again in a bit.`);
  } finally {
    hide(els.loading);
    els.scanBtn.disabled = false;
  }
}

function render(result) {
  els.totalSol.textContent = formatSol(result.total);
  els.acctCount.textContent = result.deadCount + result.surplus.length;
  els.deadSol.textContent = `${formatSol(result.totalRecoverable)} SOL`;
  els.surplusSol.textContent = `${formatSol(result.totalSurplus)} SOL`;
  els.scannedAt.textContent =
    `scanned ${new Date(result.scannedAt).toLocaleTimeString()} · ${result.deadCount} dead, ${result.surplus.length} with excess`;
  show(els.results);

  // Keep the toolbar badge in sync with what the popup shows.
  chrome.runtime.sendMessage({ type: 'badge', total: result.total.toString() }).catch(() => {});
}

els.scanBtn.addEventListener('click', () => {
  const owner = els.addr.value.trim();
  if (!isPlausibleAddress(owner)) {
    setError('that doesn\'t look like a Solana address — check it and try again.');
    return;
  }
  els.addr.value = owner;
  runScan(owner, { force: true });
});

els.addr.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.scanBtn.click();
});

els.reclaimBtn.addEventListener('click', () => {
  // Placeholder until step 2 wires Phantom + claim transactions.
  setError('claim flow lands in step 2 — scan is live, signing comes next.');
});

// Scan-on-open: zero clicks to the number. The habit starts here.
document.addEventListener('DOMContentLoaded', async () => {
  const { owner } = await chrome.storage.local.get('owner');
  if (owner) {
    els.addr.value = owner;
    runScan(owner);
  }
});
