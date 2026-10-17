// Shared backend API helpers.

export const API_BASE = 'https://rug-reclaim-api.chideraezeudu2.workers.dev';

// Public landing page (referral links point here). Update when the custom domain goes live.
export const SITE_URL = API_BASE;

// Accept a bare wallet address OR a pasted invite link (…?ref=WALLET).
export function extractReferrer(input) {
  const t = (input || '').trim();
  if (!t) return null;
  try {
    if (/^https?:\/\//i.test(t)) {
      const u = new URL(t);
      const ref = u.searchParams.get('ref');
      if (ref && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ref)) return ref;
    }
  } catch {}
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t) ? t : null;
}

export function inviteLink(wallet) {
  return `${SITE_URL}/?ref=${wallet}`;
}

async function req(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `API ${res.status} on ${path}`);
  return json;
}

export const api = {
  config: () => req('/config'),
  claimCount: (wallet) => req(`/claims/count/${wallet}`),
  referralInfo: (wallet) => req(`/referrals/${wallet}`),
  logClaim: (body) => req('/claims', { method: 'POST', body: JSON.stringify(body) }),
  registerReferral: (body) =>
    req('/referrals/register', { method: 'POST', body: JSON.stringify(body) }),
  stats: () => req('/stats'),
};
