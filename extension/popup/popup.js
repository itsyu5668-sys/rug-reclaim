// Sol Burn popup — multi-wallet, gamified. Bundled via esbuild.

import { createRpc, DEFAULT_RPC_ENDPOINT } from '../lib/rpc.js';
import { scanWallet, formatSol, formatSolExact, isPlausibleAddress } from '../lib/scan.js';
import { buildClaimTransactions, formatSolBigint } from '../lib/claim-tx.js';
import { api, API_BASE } from '../lib/api.js';
import {
  saveScan, loadScan, getWallets, addWallet, removeWallet,
  getSelectedWallet, setSelectedWallet,
} from '../lib/store.js';

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

let state = null;          // { wallets, selected, perWallet, agg }
let currentScan = null;    // focused wallet scan (for claim)
let currentConfig = null;
let currentClaimMeta = null;
let retryFn = null;
let lastGlobalError = '';
window.addEventListener('error', (e) => {
  lastGlobalError = `${e.message}\n${(e.error && e.error.stack) || ''}`.slice(0, 1500);
});

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
async function scanOne(owner, force) {
  if (!force) {
    const cached = await loadScan(owner);
    if (cached && Date.now() - cached.scannedAt < SCAN_CACHE_MS) return cached;
  }
  const { rpcEndpoint } = await chrome.storage.local.get('rpcEndpoint');
  const rpc = createRpc(rpcEndpoint || DEFAULT_RPC_ENDPOINT);
  const result = await scanWallet(owner, rpc);
  await saveScan(owner, result);
  return result;
}

function aggregate(list) {
  return {
    total: list.reduce((s, p) => s + p.total, 0n),
    totalRecoverable: list.reduce((s, p) => s + p.totalRecoverable, 0n),
    totalSurplus: list.reduce((s, p) => s + p.totalSurplus, 0n),
    deadCount: list.reduce((s, p) => s + p.deadCount, 0),
    surplusCount: list.reduce((s, p) => s + p.surplus.length, 0),
    walletCount: list.length,
    scannedAt: list.reduce((m, p) => Math.max(m, p.scannedAt), 0),
  };
}

function setBadge(total) {
  if (typeof total !== 'bigint') return; // never send a half-shaped value
  chrome.runtime.sendMessage({ type: 'badge', total: total.toString() }).catch(() => {});
}

const LOAD_LINES = [
  'Sniffing out dead bags…',
  'Checking every rug you ever touched…',
  'Counting dust…',
  'Peeking at Token-2022…',
];
let loadTimer = null;
function startLoadLines() {
  let i = 0;
  $('loadStatus').textContent = LOAD_LINES[0];
  loadTimer = setInterval(() => {
    i = (i + 1) % LOAD_LINES.length;
    $('loadStatus').textContent = LOAD_LINES[i];
  }, 1300);
}
function stopLoadLines() { if (loadTimer) clearInterval(loadTimer); loadTimer = null; }

function shortAddr(a) {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

async function refresh(force = false) {
  const wallets = await getWallets();
  if (!wallets.length) {
    hide($('walletChips'));
    await renderKnownWallets();
    showView('view-scan');
    return;
  }
  showView('view-loading');
  startLoadLines();
  try {
    const perWallet = [];
    for (const w of wallets) perWallet.push(await scanOne(w, force));
    stopLoadLines();
    const selected = await getSelectedWallet();
    const inScope = selected === 'all' ? perWallet : perWallet.filter((p) => p.owner === selected);
    const agg = aggregate(inScope.length ? inScope : perWallet);
    const grand = perWallet.reduce((s, p) => s + p.total, 0n);
    setBadge(grand);
    state = { wallets, selected, perWallet, agg };
    currentScan = inScope.length === 1 ? inScope[0] : null;
    await renderChips();
    if (agg.total > 0n) await renderResults();
    else renderEmpty();
  } catch (err) {
    stopLoadLines();
    const hint = /403/.test(err.message || '')
      ? 'The network endpoint blocked the scan. Try again, or set a custom RPC endpoint in Settings.'
      : `Couldn't reach the network. Check your connection and try again.`;
    const diag = `${err.message || err}\n${lastGlobalError}`.slice(0, 1500);
    renderError('Scan failed', hint, diag, () => refresh(true));
  }
}

async function renderChips() {
  const box = $('walletChips');
  const { wallets, selected, perWallet } = state;
  if (wallets.length < 2) { hide(box); return; }
  show(box);
  box.innerHTML = '';
  const totals = new Map(perWallet.map((p) => [p.owner, p.total]));
  const mk = (label, sub, isOn, onClick) => {
    const b = document.createElement('button');
    b.className = 'chip' + (isOn ? ' on' : '');
    b.innerHTML = `<span class="dot"></span><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}`;
    b.addEventListener('click', onClick);
    box.appendChild(b);
  };
  mk('All', wallets.length > 1 ? `${wallets.length} wallets` : '', selected === 'all', () => selectWallet('all'));
  wallets.forEach((w, i) => {
    const t = totals.get(w) || 0n;
    mk(`Wallet ${i + 1}`, t > 0n ? `${formatSol(t)} SOL` : shortAddr(w), selected === w, () => selectWallet(w));
  });
  mk('＋', '', false, () => { showView('view-scan'); renderKnownWallets(); });
}

async function selectWallet(sel) {
  await setSelectedWallet(sel);
  refresh(false);
}

/* ---------------- results ---------------- */
function countUp(el, target, fmt) {
  const dur = 900;
  const t0 = performance.now();
  const targetNum = Number(target);
  function frame(t) {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    try {
      el.textContent = fmt(BigInt(Math.floor(targetNum * e)));
    } catch { el.textContent = fmt(target); return; }
    if (p < 1) requestAnimationFrame(frame);
    else el.textContent = fmt(target);
  }
  requestAnimationFrame(frame);
}

async function renderResults() {
  showView('view-results');
  const { selected, perWallet, agg } = state;
  // single wallet behaves as focused mode even when "All" is selected
  const allMode = selected === 'all' && perWallet.length > 1;
  if (!allMode && perWallet.length === 1) currentScan = perWallet[0];
  countUp($('heroAmt'), agg.totalRecoverable, formatSolExact);
  $('heroKicker').textContent =
    allMode ? `Trapped across ${agg.walletCount} wallets` : 'Trapped in dead bags';
  const bits = [`${agg.deadCount} dead account${agg.deadCount === 1 ? '' : 's'}`];
  if (agg.totalSurplus > 0n) bits.push(`${formatSol(agg.totalSurplus)} SOL excess rent on live`);
  $('heroSub').textContent = bits.join(' · ');

  const price = await solPriceUsd();
  const usdEl = $('usdEst');
  if (price) {
    const usd = (Number(agg.totalRecoverable) / 1e9) * price;
    usdEl.textContent = `~$${usd >= 100 ? Math.round(usd).toLocaleString() : usd.toFixed(2)} USD`;
    show(usdEl);
  } else hide(usdEl);

  const cards = $('walletCards');
  cards.innerHTML = '';
  if (allMode) {
    hide($('detailCard')); hide($('feeBanner')); hide($('reclaimBtn')); hide($('refToggle'));
    perWallet.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'wcard';
      d.style.animationDelay = `${i * 0.07}s`;
      d.innerHTML =
        `<div class="ava">S</div>` +
        `<div class="meta"><div class="a">Wallet ${i + 1} · ${shortAddr(p.owner)}</div>` +
        `<div class="b">${formatSolExact(p.totalRecoverable)} SOL sweepable</div></div>` +
        `<button class="go" title="Open wallet">→</button>`;
      d.addEventListener('click', () => selectWallet(p.owner));
      cards.appendChild(d);
    });
  } else {
    show($('detailCard'));
    $('deadVal').textContent = `${formatSolExact(agg.totalRecoverable)} SOL`;
    $('surplusVal').textContent = `${formatSolExact(agg.totalSurplus)} SOL`;
    $('scannedAt').textContent =
      `Scanned ${new Date(agg.scannedAt).toLocaleTimeString()} · ${agg.deadCount} dead, ${agg.surplusCount} with excess`;
    show($('reclaimBtn')); show($('refToggle'));
    await loadFeeBanner(selected);
  }
}

async function loadFeeBanner(owner) {
  const banner = $('feeBanner');
  const btn = $('reclaimBtn');
  if (!currentScan || currentScan.deadCount === 0) {
    $('reclaimLabel').textContent = 'Nothing to reclaim';
    btn.disabled = true;
    hide(banner);
    return;
  }
  btn.disabled = false;
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

    const total = BigInt(currentScan.totalRecoverable);
    if (free) {
      banner.innerHTML =
        `<div class="fee-left"><div class="fee-ic">✨</div><div>` +
        `<div class="fee-title">First cleanup FREE <span class="norm">, keep all ${formatSol(currentScan.totalRecoverable)} SOL</span></div>` +
        `<div class="fee-sub">Regular 30% thereafter</div></div></div>` +
        `<span class="fee-tag">100% OFF</span>`;
      $('reclaimLabel').textContent = `Sweep ${formatSol(currentScan.totalRecoverable)} SOL`;
    } else {
      const fee = (total * BigInt(config.feeBps)) / 10000n;
      const youGet = total - fee;
      banner.innerHTML =
        `<div class="fee-left"><div class="fee-ic">✨</div><div>` +
        `<div class="fee-title">You keep <b>${formatSolBigint(youGet)} SOL</b></div>` +
        `<div class="fee-sub">Fee ${formatSolBigint(fee)} SOL (${config.feeBps / 100}%) · shown in Phantom before you sign</div></div></div>` +
        `<span class="fee-tag">${config.feeBps / 100}% FEE</span>`;
      $('reclaimLabel').textContent = `Sweep ${formatSolBigint(youGet)} SOL`;
    }
    show(banner);
    show($('refToggle'));
    $('refToggle').classList.toggle('hidden', !!referrer);
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
  $('xpFill').style.width = '4%';
  $('xpLabel').textContent = 'Opening signer…';
  const rows = $('pipeRows');
  rows.innerHTML = '';
  txs.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'pipe-row';
    row.id = `pipe-${i}`;
    row.innerHTML =
      `<div class="pipe-ic wait">·</div>` +
      `<div class="pipe-main"><div class="pipe-title">Sweep ${i + 1} of ${txs.length}</div>` +
      `<div class="pipe-sub dim">Waiting</div></div>`;
    rows.appendChild(row);
  });
}

function updatePipeline(done, total, signature, txs) {
  $('xpFill').style.width = `${Math.round((done / total) * 100)}%`;
  $('xpLabel').textContent = done >= total ? 'Done' : `Sweeping… ${done}/${total} signed`;
  $('pipeStep').textContent = `Step ${done} of ${total}`;
  for (let i = 0; i < total; i++) {
    const row = $(`pipe-${i}`);
    if (!row) continue;
    const ic = row.querySelector('.pipe-ic');
    const sub = row.querySelector('.pipe-sub');
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
      sub.textContent = `Swept ${accts} dead bag${accts === 1 ? '' : 's'}`;
    } else if (i === done) {
      ic.className = 'pipe-ic busy';
      ic.textContent = '◌';
      sub.className = 'pipe-sub dim';
      sub.textContent = 'Awaiting signature…';
    }
  }
  void signature;
}

function burst(container) {
  const colors = ['#8ed462', '#d9a821', '#2c2e2a', '#6db84a'];
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const ang = Math.random() * Math.PI * 2;
    const dist = 70 + Math.random() * 100;
    p.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(ang) * dist}px`);
    p.style.background = colors[i % colors.length];
    p.style.left = '50%';
    p.style.top = '34%';
    container.appendChild(p);
    setTimeout(() => p.remove(), 1400);
  }
}

/* ---------------- wallet management ---------------- */
async function renderKnownWallets() {
  const wallets = await getWallets();
  const card = $('knownWalletsCard');
  const list = $('knownWallets');
  if (!wallets.length) { hide(card); return; }
  show(card);
  list.innerHTML = '';
  wallets.forEach((w, i) => {
    const d = document.createElement('div');
    d.className = 'wcard';
    d.innerHTML = `<div class="ava">S</div><div class="meta"><div class="a">Wallet ${i + 1}</div><div class="b" style="font-family:ui-monospace,monospace;font-size:12px">${shortAddr(w)}</div></div><button class="go">→</button>`;
    d.addEventListener('click', async () => {
      await setSelectedWallet(w);
      refresh(false);
    });
    list.appendChild(d);
  });
}

async function renderWalletManage() {
  const wallets = await getWallets();
  const box = $('walletManage');
  box.innerHTML = '';
  if (!wallets.length) {
    box.innerHTML = '<p class="micro">No wallets yet.</p>';
    return;
  }
  wallets.forEach((w, i) => {
    const d = document.createElement('div');
    d.className = 'wmrow';
    d.innerHTML = `<span>Wallet ${i + 1} · ${shortAddr(w)}</span><button class="x" title="Remove">×</button>`;
    d.querySelector('.x').addEventListener('click', async () => {
      if (!confirm(`Remove wallet ${shortAddr(w)}?`)) return;
      await removeWallet(w);
      await renderWalletManage();
      await renderChipsSafe();
    });
    box.appendChild(d);
  });
}

async function renderChipsSafe() {
  if (state) await renderChips();
}

/* ---------------- events ---------------- */
$('addWalletBtn').addEventListener('click', async () => {
  const addr = $('addrInput').value.trim();
  if (!isPlausibleAddress(addr)) {
    const e = $('addrError');
    e.textContent = "That doesn't look like a Solana address. Check it and try again.";
    show(e);
    return;
  }
  hide($('addrError'));
  await addWallet(addr);
  await setSelectedWallet(addr);
  refresh(true);
});
$('addrInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addWalletBtn').click(); });

$('reclaimBtn').addEventListener('click', async () => {
  if (!currentScan || currentScan.deadCount === 0 || !currentConfig) return;
  const owner = currentScan.owner;
  const btn = $('reclaimBtn');
  btn.disabled = true;
  $('reclaimLabel').textContent = 'Preparing…';
  try {
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
    renderError('Claim failed', `Couldn't prepare the claim: ${err.message}`, `${err.stack || ''}\n${lastGlobalError}`.slice(0, 1500), () =>
      $('reclaimBtn').click(),
    );
  }
});

$('refToggle').addEventListener('click', () => $('refBox').classList.toggle('hidden'));
$('diagToggle').addEventListener('click', () => $('diagBox').classList.toggle('hidden'));
$('errRetryBtn').addEventListener('click', () => { if (retryFn) retryFn(); });
$('doneScanBtn').addEventListener('click', () => refresh(true));
$('emptyScanBtn').addEventListener('click', () => refresh(true));

/* settings */
function openSettings() {
  showView('view-settings');
  chrome.storage.local.get(['thresholdSol', 'rpcEndpoint']).then(({ thresholdSol, rpcEndpoint }) => {
    $('thresholdInput').value = thresholdSol ?? '0.05';
    $('rpcInput').value = rpcEndpoint || '';
  });
  renderWalletManage();
}
$('settingsBtn').addEventListener('click', openSettings);
$('settingsBack').addEventListener('click', () => refresh(false));
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
  if (!confirm('Clear wallets, scan cache and settings?')) return;
  const keys = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(
    Object.keys(keys).filter(
      (k) => k.startsWith('scan:') || ['wallets', 'selectedWallet', 'owner', 'thresholdSol', 'rpcEndpoint', 'solPrice', 'solPriceAt'].includes(k),
    ),
  );
  await chrome.storage.session.remove('pendingClaim');
  state = null;
  currentScan = null;
  refresh(false);
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
      $('doneAmount').textContent = `+${formatSolExact(total)}`;
      burst($('doneWrap'));
      await chrome.storage.session.remove('pendingClaim').catch(() => {});
      setTimeout(() => refresh(true), 2500);
    })();
  } else if (msg.type === 'claimFailed') {
    renderError('Claim failed', msg.error, '', () => $('reclaimBtn').click());
  }
});

/* init: scan-on-open */
document.addEventListener('DOMContentLoaded', () => {
  refresh(false);
});
