// Sol Burn popup — all screens wired. Bundled via esbuild.

import { createRpc, DEFAULT_RPC_ENDPOINT } from '../lib/rpc.js';
import { scanWallet, formatSol, isPlausibleAddress } from '../lib/scan.js';
import { buildClaimTransactions, formatSolBigint } from '../lib/claim-tx.js';
import { api, API_BASE } from '../lib/api.js';

const SCAN_CACHE_MS = 10 * 60 * 1000;
const SIGN_URL = `${API_BASE}/sign`;
const PRICE_CACHE_MS = 10 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const VIEWS = ['view-scan', 'view-loading', 'view-results', 'view-claiming', 'view-done', 'view-empty', 'view-error', 'view-settings'];

function showView(id) {
  for (const v of VIEWS) $(v).classList.toggle('hidden', v !== id);
}
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

let currentScan = null;
let currentConfig = null;
let currentClaimMeta = null;
let retryFn = null;

/* ---------------- price ---------------- */
async function solPriceUsd() {
  try {
    const cached = (await chrome.storage.local.get(['solPrice', 'solPriceAt'])) || {};
    if (cached.solPrice && Date.now() - (cached.solPriceAt || 0) < PRICE_CACHE_MS) return cached.solPrice;
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const json = await res.json();
    const price = json?.solana?.usd;
    if (price) {
      await chrome.storage.local.set({ solPrice: price, solPriceAt: Date.now() });
      return price;
    }
  } catch {}
  return null;
}

/* ---------------- scan ---------------- */
async function runScan(owner, { force = false } = {}) {
  showView('view-loading');
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
    chrome.runtime.sendMessage({ type: 'badge', total: result.total.toString() }).catch(() => {});
    if (result.total > 0n) await renderResults(result, owner);
    else renderEmpty();
  } catch (err) {
    const hint = /403/.test(err.message || '')
      ? 'The network endpoint blocked the scan. Try again, or set a custom RPC endpoint in Settings.'
      : `Couldn't reach the network. Check your connection and try again.`;
    renderError('Scan failed', hint, err.message, () => runScan(owner, { force: true }));
  }
}

async function renderResults(result, owner) {
  showView('view-results');
  $('totalSol').textContent = formatSol(result.total);
  $('acctCount').textContent = String(result.deadCount + result.surplus.length);
  $('deadLabel').textContent = `Dead accounts (${result.deadCount})`;
  $('deadSol').textContent = `${formatSol(result.totalRecoverable)} SOL`;
  $('surplusLabel').textContent = `Excess rent on live (${result.surplus.length})`;
  $('surplusSol').textContent = `${formatSol(result.totalSurplus)} SOL`;
  $('scannedAt').textContent = `Scanned ${new Date(result.scannedAt).toLocaleTimeString()} · ${result.deadCount} dead, ${result.surplus.length} with excess`;

  // USD estimate (best-effort, hidden on failure)
  const price = await solPriceUsd();
  const usdEl = $('usdEst');
  if (price) {
    const usd = (Number(result.total) / 1e9) * price;
    usdEl.textContent = `~$${usd >= 100 ? Math.round(usd).toLocaleString() : usd.toFixed(2)} USD`;
  } else {
    usdEl.textContent = '';
  }

  const hasDead = result.deadCount > 0;
  const btn = $('reclaimBtn');
  btn.disabled = !hasDead;
  const banner = $('feeBanner');

  if (!hasDead) {
    $('reclaimLabel').textContent = 'Nothing to reclaim';
    banner.classList.add('hidden');
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
    if (free) {
      banner.innerHTML =
        `<div class="fee-left"><div class="fee-ic">✨</div><div>` +
        `<div class="fee-title">First cleanup FREE <span class="norm">, keep all ${formatSol(result.totalRecoverable)} SOL</span></div>` +
        `<div class="fee-sub">Regular 30% thereafter</div></div></div>` +
        `<span class="fee-tag">100% OFF</span>`;
      $('reclaimLabel').textContent = `Reclaim ${formatSol(result.totalRecoverable)} SOL`;
    } else {
      const fee = (total * BigInt(config.feeBps)) / 10000n;
      const youGet = total - fee;
      banner.innerHTML =
        `<div class="fee-left"><div class="fee-ic">✨</div><div>` +
        `<div class="fee-title">You keep <b>${formatSolBigint(youGet)} SOL</b></div>` +
        `<div class="fee-sub">Fee ${formatSolBigint(fee)} SOL (${config.feeBps / 100}%) · shown in Phantom before you sign</div></div></div>` +
        `<span class="fee-tag">${config.feeBps / 100}% FEE</span>`;
      $('reclaimLabel').textContent = `Reclaim ${formatSolBigint(youGet)} SOL`;
    }
    show(banner);
    $('refToggle').parentElement.classList.toggle('hidden', !!referrer);
  } catch (err) {
    banner.innerHTML = `<div class="fee-left"><div><div class="fee-title">Couldn't load fee info</div><div class="fee-sub">Reclaim still works. Try again.</div></div></div>`;
    show(banner);
    currentClaimMeta = { free: false, referrer: null };
  }
}

function renderEmpty() {
  showView('view-empty');
}

function renderError(title, msg, diag, retry) {
  showView('view-error');
  $('errTitle').textContent = title;
  $('errMsg').textContent = msg;
  $('diagText').textContent = diag || 'no details';
  hide($('diagBox'));
  retryFn = retry || null;
  $('errRetryBtn').style.display = retry ? '' : 'none';
}

/* ---------------- claiming pipeline ---------------- */
function renderPipeline(txs) {
  showView('view-claiming');
  $('pipeStep').textContent = '';
  const rows = $('pipeRows');
  rows.innerHTML = '';
  txs.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'pipe-row';
    row.id = `pipe-${i}`;
    row.innerHTML =
      `<div class="pipe-ic wait">·</div>` +
      `<div class="pipe-main"><div class="pipe-title">Transaction ${i + 1} of ${txs.length}</div>` +
      `<div class="pipe-sub dim">Waiting</div></div>`;
    rows.appendChild(row);
  });
}

function updatePipeline(done, total, signature, txs) {
  $('pipeStep').textContent = `Step ${done} of ${total}`;
  for (let i = 0; i < total; i++) {
    const row = $(`pipe-${i}`);
    if (!row) continue;
    const ic = row.querySelector('.pipe-ic');
    const sub = row.querySelector('.pipe-sub');
    const main = row.querySelector('.pipe-main');
    if (i < done) {
      ic.className = 'pipe-ic done';
      ic.textContent = '✓';
      sub.className = 'pipe-sub';
      const amt = formatSolBigint(BigInt(txs[i].lamportsReclaimed));
      if (!row.querySelector('.pipe-amt')) {
        const amtEl = document.createElement('div');
        amtEl.className = 'pipe-amt';
        amtEl.textContent = `+${amt} SOL`;
        row.appendChild(amtEl);
      }
      const accts = txs[i].accountsClosed;
      sub.textContent = `Reclaimed ${accts} account${accts === 1 ? '' : 's'}`;
      void main;
    } else if (i === done) {
      ic.className = 'pipe-ic busy';
      ic.textContent = '◌';
      sub.className = 'pipe-sub dim';
      sub.textContent = 'Awaiting signature…';
    }
  }
  void signature;
}

/* ---------------- events ---------------- */
$('scanBtn').addEventListener('click', () => {
  const owner = $('addr').value.trim();
  if (!isPlausibleAddress(owner)) {
    const e = $('addrError');
    e.textContent = "That doesn't look like a Solana address. Check it and try again.";
    show(e);
    return;
  }
  hide($('addrError'));
  runScan(owner, { force: true });
});
$('addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('scanBtn').click(); });

$('reclaimBtn').addEventListener('click', async () => {
  if (!currentScan || currentScan.deadCount === 0 || !currentConfig) return;
  const btn = $('reclaimBtn');
  btn.disabled = true;
  $('reclaimLabel').textContent = 'Preparing…';
  try {
    const owner = (await chrome.storage.local.get('owner')).owner;
    const { free, referrer } = currentClaimMeta;
    const bhRes = await fetch(`${API_BASE}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] }),
    });
    const blockhash = (await bhRes.json()).result?.value?.blockhash;
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

    const refInput = $('referrer').value.trim();
    const referrerToRegister = !referrer && refInput && isPlausibleAddress(refInput) ? refInput : null;

    await chrome.storage.session.set({
      pendingClaim: { txs, owner, free, referrer, referrerToRegister, createdAt: Date.now() },
    });

    renderPipeline(txs);
    pipelineTxs = txs;
    await chrome.tabs.create({ url: `${SIGN_URL}#ext=${chrome.runtime.id}` });
  } catch (err) {
    renderError('Claim failed', `Couldn't prepare the claim: ${err.message}`, err.stack, () =>
      $('reclaimBtn').click(),
    );
  }
});

$('refToggle').addEventListener('click', () => $('refBox').classList.toggle('hidden'));
$('diagToggle').addEventListener('click', () => $('diagBox').classList.toggle('hidden'));
$('errRetryBtn').addEventListener('click', () => { if (retryFn) retryFn(); });
$('doneScanBtn').addEventListener('click', async () => {
  const { owner } = await chrome.storage.local.get('owner');
  if (owner) runScan(owner, { force: true });
});
$('emptyScanBtn').addEventListener('click', async () => {
  const { owner } = await chrome.storage.local.get('owner');
  if (owner) runScan(owner, { force: true });
  else showView('view-scan');
});

/* settings */
function openSettings() {
  showView('view-settings');
  chrome.storage.local.get(['thresholdSol', 'rpcEndpoint']).then(({ thresholdSol, rpcEndpoint }) => {
    $('thresholdInput').value = thresholdSol ?? '0.05';
    $('rpcInput').value = rpcEndpoint || '';
  });
}
$('settingsBtn').addEventListener('click', openSettings);
document.querySelectorAll('.settings-go').forEach((b) => b.addEventListener('click', openSettings));
$('settingsBack').addEventListener('click', async () => {
  const { owner } = await chrome.storage.local.get('owner');
  if (currentScan) {
    if (currentScan.total > 0n) renderResults(currentScan, owner);
    else renderEmpty();
  } else if (owner) runScan(owner);
  else showView('view-scan');
});
$('settingsSave').addEventListener('click', async () => {
  const t = parseFloat($('thresholdInput').value);
  const rpc = $('rpcInput').value.trim();
  await chrome.storage.local.set({
    thresholdSol: isNaN(t) || t <= 0 ? 0.05 : t,
    ...(rpc ? { rpcEndpoint: rpc } : {}),
  });
  if (!rpc) await chrome.storage.local.remove('rpcEndpoint');
  $('settingsSave').textContent = 'Saved ✓';
  setTimeout(() => ($('settingsSave').textContent = 'Save settings'), 1500);
});
$('settingsReset').addEventListener('click', async () => {
  if (!confirm('Clear the stored wallet, scan cache and settings?')) return;
  const keys = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(keys).filter((k) => k.startsWith('scan:') || ['owner', 'lastScan', 'thresholdSol', 'rpcEndpoint', 'solPrice', 'solPriceAt'].includes(k)));
  await chrome.storage.session.remove('pendingClaim');
  currentScan = null;
  showView('view-scan');
});
$('ghLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://github.com/itsyu5668-sys/rug-reclaim' });
});

/* relayed claim events from the background worker */
let pipelineTxs = [];
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'claimProgress') {
    updatePipeline(msg.done, msg.total, msg.signature, pipelineTxs);
  } else if (msg.type === 'claimComplete') {
    (async () => {
      const total = pipelineTxs.reduce((s, t) => s + BigInt(t.lamportsReclaimed), 0n);
      showView('view-done');
      $('doneAmount').textContent = `+${formatSolBigint(total)} SOL`;
      await chrome.storage.session.remove('pendingClaim').catch(() => {});
      const { owner } = await chrome.storage.local.get('owner');
      setTimeout(() => { if (owner) runScan(owner, { force: true }); }, 2500);
    })();
  } else if (msg.type === 'claimFailed') {
    renderError('Claim failed', msg.error, '', () => $('reclaimBtn').click());
  }
});

/* init: scan-on-open */
document.addEventListener('DOMContentLoaded', async () => {
  const { owner } = await chrome.storage.local.get('owner');
  if (owner) {
    $('addr').value = owner;
    runScan(owner);
  } else {
    showView('view-scan');
  }
});
