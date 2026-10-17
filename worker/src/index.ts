import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env.js';
import { db } from './db.js';
import { isValidAddress, verifySignature } from './solana.js';
// @ts-expect-error text import via wrangler [[rules]]
import signerBundle from './static/signer.bundle.txt';

const app = new Hono<{ Bindings: Env }>();

// CORS: allow the extension + any explicitly listed origins.
app.use('*', async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = c.req.header('origin') || '';
  const ok =
    !origin ||
    allowed.length === 0 ||
    allowed.some((pat) =>
      pat.endsWith('*') ? origin.startsWith(pat.slice(0, -1)) : origin === pat,
    );
  if (!ok) return c.text('forbidden', 403);
  await next();
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Headers', 'content-type');
    c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
});
app.options('*', (c) => new Response(null, { status: 204 }));

app.get('/health', (c) => c.json({ ok: true, service: 'rug-reclaim-api' }));

// Signer tab: a real https:// page where Phantom injects its provider.
// Opened by the extension as /sign#ext=<extensionId>. The bundled signer JS
// pulls the pending claim from the extension, connects Phantom, signs, and
// reports back. This page never sees keys — it only forwards signatures.
app.get('/sign', (c) =>
  c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rug Reclaim — sign in Phantom</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f0d1a; color: #e8e6f0;
         display: flex; align-items: center; justify-content: center;
         min-height: 100vh; margin: 0; }
  .card { max-width: 420px; padding: 32px; text-align: center;
          background: #17142a; border-radius: 16px; border: 1px solid #2c2750; }
  .brand { font-weight: 800; letter-spacing: 2px; color: #a78bfa; margin-bottom: 16px; }
  #status { line-height: 1.6; }
  #status.ok { color: #6ee7b7; }
  #status.err { color: #fca5a5; }
  .dim { opacity: .6; font-size: .9em; }
  .spinner { width: 32px; height: 32px; margin: 0 auto 16px; border-radius: 50%;
             border: 3px solid #2c2750; border-top-color: #a78bfa;
             animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">RUG RECLAIM</div>
    <div class="spinner"></div>
    <div id="status">loading…</div>
  </div>
<script>${signerBundle}</script>
</body>
</html>`),
);

app.get('/config', (c) =>
  c.json({
    feeWallet: c.env.FEE_WALLET || null,
    feeBps: Number(c.env.FEE_BPS || 3000),
    referrerBpsOfFee: Number(c.env.REFERRER_BPS_OF_FEE || 1667),
    firstClaimFree: (c.env.FIRST_CLAIM_FREE || 'true') === 'true',
    rpcProxy: '/rpc',
  }),
);

// ---- RPC proxy -----------------------------------------------------------
const ALLOW_METHODS = new Set([
  'getAccountInfo',
  'getBalance',
  'getLatestBlockhash',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getSignatureStatuses',
  'getSlot',
  'getTokenAccountBalance',
  'sendRawTransaction',
  'simulateTransaction',
]);

app.post('/rpc', async (c) => {
  const rpcUrl = c.env.RPC_URL;
  if (!rpcUrl) return c.json({ error: 'RPC not configured' }, 503);
  const body = await c.req.json().catch(() => null);
  const { method, params, id } = body ?? {};
  if (typeof method !== 'string' || !ALLOW_METHODS.has(method)) {
    return c.json({ error: 'method not allowed' }, 400);
  }
  try {
    const upstream = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: id ?? 1, method, params: params ?? [] }),
    });
    return c.json(await upstream.json(), upstream.status as any);
  } catch {
    return c.json({ error: 'upstream RPC error' }, 502);
  }
});

// ---- Referrals ------------------------------------------------------------
function parseReferralMessage(message: string): { referrer: string; ts: number } | null {
  const m = /^rug-reclaim:referral:([1-9A-HJ-NP-Za-km-z]{32,44}):(\d+)$/.exec(message);
  if (!m) return null;
  return { referrer: m[1], ts: Number(m[2]) };
}

app.post('/referrals/register', async (c) => {
  const sb = db(c.env);
  if (!sb) return c.json({ error: 'database not configured' }, 503);
  const { wallet, referrer, message, signature } = (await c.req.json().catch(() => null)) ?? {};
  if (!wallet || !referrer || !message || !signature) {
    return c.json({ error: 'wallet, referrer, message, signature required' }, 400);
  }
  if (!isValidAddress(wallet) || !isValidAddress(referrer)) {
    return c.json({ error: 'invalid address' }, 400);
  }
  if (wallet === referrer) return c.json({ error: 'self-referral not allowed' }, 400);
  const parsed = parseReferralMessage(message);
  if (!parsed || parsed.referrer !== referrer) {
    return c.json({ error: 'malformed message' }, 400);
  }
  if (Math.abs(Date.now() / 1000 - parsed.ts) > 600) {
    return c.json({ error: 'message expired' }, 400);
  }
  if (!verifySignature(wallet, message, signature)) {
    return c.json({ error: 'bad signature' }, 401);
  }
  const { data: existing } = await sb
    .from('rug_referrals')
    .select('id')
    .eq('wallet', wallet)
    .maybeSingle();
  if (existing) return c.json({ error: 'already registered' }, 409);
  const { error } = await sb.from('rug_referrals').insert({ wallet, referrer });
  if (error) return c.json({ error: 'db error' }, 500);
  return c.json({ ok: true });
});

app.get('/referrals/:wallet', async (c) => {
  const sb = db(c.env);
  if (!sb) return c.json({ error: 'database not configured' }, 503);
  const wallet = c.req.param('wallet');
  if (!isValidAddress(wallet)) return c.json({ error: 'invalid address' }, 400);
  const [{ data: mine }, { data: referred, count }] = await Promise.all([
    sb.from('rug_referrals').select('referrer').eq('wallet', wallet).maybeSingle(),
    sb.from('rug_referrals').select('wallet', { count: 'exact' }).eq('referrer', wallet),
  ]);
  const { data: earnings } = await sb
    .from('rug_claims')
    .select('referrer_fee_lamports')
    .eq('referrer', wallet);
  const earnedLamports = (earnings ?? []).reduce(
    (s, r) => s + Number((r as any).referrer_fee_lamports || 0),
    0,
  );
  return c.json({
    referrer: (mine as any)?.referrer ?? null,
    referredCount: count ?? 0,
    referred: (referred ?? []).map((r: any) => r.wallet),
    earnedLamports,
  });
});

// ---- Claims ----------------------------------------------------------------
app.post('/claims', async (c) => {
  const sb = db(c.env);
  if (!sb) return c.json({ error: 'database not configured' }, 503);
  const body = (await c.req.json().catch(() => null)) ?? {};
  const { wallet, txSignature, accountsClosed, lamportsReclaimed, feeLamports, referrerFeeLamports, referrer } = body;
  if (!wallet || !txSignature || !isValidAddress(wallet)) {
    return c.json({ error: 'wallet and txSignature required' }, 400);
  }
  if (referrer && !isValidAddress(referrer)) {
    return c.json({ error: 'invalid referrer' }, 400);
  }
  const { error } = await sb.from('rug_claims').insert({
    wallet,
    tx_signature: String(txSignature),
    accounts_closed: Number(accountsClosed) || 0,
    lamports_reclaimed: Number(lamportsReclaimed) || 0,
    fee_lamports: Number(feeLamports) || 0,
    referrer_fee_lamports: Number(referrerFeeLamports) || 0,
    referrer: referrer || null,
  });
  if (error) {
    if ((error as any).code === '23505') return c.json({ ok: true, duplicate: true });
    return c.json({ error: 'db error' }, 500);
  }
  return c.json({ ok: true });
});

app.get('/claims/count/:wallet', async (c) => {
  const sb = db(c.env);
  if (!sb) return c.json({ error: 'database not configured' }, 503);
  const wallet = c.req.param('wallet');
  if (!isValidAddress(wallet)) return c.json({ error: 'invalid address' }, 400);
  const { count } = await sb
    .from('rug_claims')
    .select('id', { count: 'exact', head: true })
    .eq('wallet', wallet);
  return c.json({ count: count ?? 0 });
});

// ---- Stats ------------------------------------------------------------------
app.get('/stats', async (c) => {
  const sb = db(c.env);
  if (!sb) {
    return c.json({
      totalReclaimedLamports: 0,
      totalAccountsClosed: 0,
      totalClaims: 0,
      totalUsers: 0,
      live: false,
    });
  }
  const { data, error } = await sb
    .from('rug_claims')
    .select('lamports_reclaimed, accounts_closed, wallet');
  if (error) return c.json({ error: 'db error' }, 500);
  const rows = (data ?? []) as any[];
  return c.json({
    totalReclaimedLamports: rows.reduce((s, r) => s + Number(r.lamports_reclaimed || 0), 0),
    totalAccountsClosed: rows.reduce((s, r) => s + Number(r.accounts_closed || 0), 0),
    totalClaims: rows.length,
    totalUsers: new Set(rows.map((r) => r.wallet)).size,
    live: true,
  });
});

export default app;
