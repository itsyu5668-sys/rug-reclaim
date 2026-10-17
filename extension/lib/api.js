// Shared backend API helpers.

export const API_BASE = 'https://rug-reclaim-api.chideraezeudu2.workers.dev';

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
