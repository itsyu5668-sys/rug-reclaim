// BigInt-safe extension storage. chrome.storage serialization of BigInt is
// unreliable across versions, so scan results are stored with explicit
// BigInt markers plus a schema version — a stale or foreign cache can never
// produce a half-shaped result object.

const SCAN_SCHEMA = 2;

function encodeBigints(value) {
  return JSON.parse(
    JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? { __bigint: v.toString() } : v)),
  );
}

function decodeBigints(value) {
  return JSON.parse(JSON.stringify(value), (k, v) =>
    v && typeof v === 'object' && typeof v.__bigint === 'string' ? BigInt(v.__bigint) : v,
  );
}

export async function saveScan(owner, result) {
  await chrome.storage.local.set({
    [`scan:${owner}`]: { schema: SCAN_SCHEMA, savedAt: Date.now(), data: encodeBigints(result) },
  });
}

export async function loadScan(owner) {
  const entry = (await chrome.storage.local.get(`scan:${owner}`))[`scan:${owner}`];
  if (!entry || entry.schema !== SCAN_SCHEMA || !entry.data) return null;
  try {
    return decodeBigints(entry.data);
  } catch {
    return null;
  }
}

export async function clearScan(owner) {
  await chrome.storage.local.remove(`scan:${owner}`);
}

// --- wallets ---------------------------------------------------------------
export async function getWallets() {
  const stored = await chrome.storage.local.get(['wallets', 'owner']);
  let wallets = Array.isArray(stored.wallets) ? [...stored.wallets] : [];
  // one-time migration from the old single-wallet key
  if (stored.owner && !wallets.includes(stored.owner)) {
    wallets.unshift(stored.owner);
    await chrome.storage.local.set({ wallets });
  }
  return wallets.filter((w) => typeof w === 'string' && w.length >= 32);
}

export async function addWallet(address) {
  const wallets = await getWallets();
  if (!wallets.includes(address)) {
    wallets.push(address);
    await chrome.storage.local.set({ wallets });
  }
  return wallets;
}

export async function removeWallet(address) {
  const wallets = (await getWallets()).filter((w) => w !== address);
  await chrome.storage.local.set({ wallets });
  await clearScan(address);
  const { selectedWallet } = await chrome.storage.local.get('selectedWallet');
  if (selectedWallet === address) await chrome.storage.local.set({ selectedWallet: 'all' });
  return wallets;
}

export async function getSelectedWallet() {
  const { selectedWallet } = await chrome.storage.local.get('selectedWallet');
  return selectedWallet || 'all';
}

export async function setSelectedWallet(sel) {
  await chrome.storage.local.set({ selectedWallet: sel });
}
