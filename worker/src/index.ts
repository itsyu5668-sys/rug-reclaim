import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env.js';
import { db } from './db.js';
import { isValidAddress, verifySignature } from './solana.js';
// @ts-expect-error text import via wrangler [[rules]]
import signerBundle from './static/signer.bundle.txt';
// @ts-expect-error text import via wrangler [[rules]]
import landingHtml from './static/landing.html';

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

// Landing page (Sol Burn marketing site).
app.get('/', (c) => c.html(landingHtml));

// Privacy Policy + Terms (required for the Chrome Web Store listing).
const LEGAL_CSS = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:"Inter",system-ui,sans-serif;background:#f5f1e4;color:#2c2e2a;line-height:1.65;padding:48px 24px;max-width:720px;margin:0 auto}h1{font-size:30px;font-weight:800;letter-spacing:-0.02em;margin-bottom:8px}h2{font-size:19px;font-weight:700;margin:28px 0 8px}.muted{color:#80827f;font-size:14px;margin-bottom:24px}p{margin:10px 0}ul{margin:10px 0 10px 20px}li{margin:6px 0}a{color:#2e6c00}`;
const legalPage = (title: string, updated: string, bodyHtml: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title} — Sol Burn</title><style>${LEGAL_CSS}</style></head><body><h1>${title}</h1><p class="muted">Last updated: ${updated}</p>${bodyHtml}<p class="muted" style="margin-top:40px"><a href="/">← Back to Sol Burn</a></p></body></html>`;

app.get('/privacy', (c) =>
  c.html(
    legalPage(
      'Privacy Policy',
      'October 17, 2026',
      `<p>Sol Burn is a Chrome extension that helps you recover SOL locked in empty Solana token accounts. This policy explains what data we handle.</p>
      <h2>What we collect</h2>
      <ul>
        <li><b>Wallet addresses you scan.</b> Stored locally in your browser to show scan history and update the toolbar badge. Never sold, never shared.</li>
        <li><b>Claim records.</b> When you complete a reclaim, we store your wallet address, the transaction signature, and the amounts recovered and paid in fees. This powers the first-cleanup-free logic and public aggregate statistics.</li>
        <li><b>Referral mappings.</b> If you register a referrer, we store the wallet-to-referrer link so referral fees can be paid.</li>
      </ul>
      <h2>What we never collect</h2>
      <ul>
        <li>Seed phrases, private keys, or any signing credentials. The extension cannot see them — signing happens in Phantom.</li>
        <li>Browsing history or activity on other websites. The extension has no content scripts and cannot see web pages.</li>
      </ul>
      <h2>Third parties</h2>
      <p>Scans query Solana RPC endpoints (default: the public Solana cluster; optionally your own Helius/QuickNode/Triton key). SOL price estimates use CoinGecko's public API. Our backend runs on Cloudflare Workers and our database on Supabase.</p>
      <h2>Contact</h2>
      <p>Open an issue at <a href="https://github.com/itsyu5668-sys/rug-reclaim">github.com/itsyu5668-sys/rug-reclaim</a>.</p>`,
    ),
  ),
);

app.get('/terms', (c) =>
  c.html(
    legalPage(
      'Terms of Service',
      'October 17, 2026',
      `<p>By using Sol Burn you agree to the following.</p>
      <h2>The service</h2>
      <p>Sol Burn scans Solana token accounts for recoverable rent and builds claim transactions you approve in your own wallet. The first cleanup per wallet is free; subsequent cleanups carry a 30% service fee taken inside the transaction you sign.</p>
      <h2>Your responsibility</h2>
      <ul>
        <li>You review every transaction in Phantom before signing. The fee is shown in the transaction preview.</li>
        <li>Closing a token account is irreversible. Only accounts with zero token balance are ever closed.</li>
        <li>Recovered amounts depend on on-chain state and may vary.</li>
      </ul>
      <h2>Referrals</h2>
      <p>If you refer another wallet, you earn a share of the service fee from their paid cleanups, paid automatically on-chain. Self-referral to farm fees is prohibited and may result in withheld payouts.</p>
      <h2>Availability</h2>
      <p>The service is provided as-is, without warranties. We may change the fee or discontinue the service at any time; the fee that applies is the one shown in the transaction you sign.</p>`,
    ),
  ),
);

// Signer tab: a real https:// page where Phantom injects its provider.
// Opened by the extension as /sign#ext=<extensionId>. The bundled signer JS
// pulls the pending claim from the extension, connects Phantom, signs, and
// reports back. This page never sees keys — it only forwards signatures.
const SIGN_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #f5f1e4; color: #2c2e2a; display: flex;
         align-items: center; justify-content: center; min-height: 100vh; padding: 24px;
         -webkit-font-smoothing: antialiased; }
  .card { background: #ffffff; border-radius: 28px; padding: 36px 40px; max-width: 460px;
          width: 100%; text-align: center; box-shadow: 0 4px 24px rgba(44,46,42,0.08); }
  .brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 6px; }
  .mark { width: 38px; height: 38px; border-radius: 50%; background: #8ed462;
          display: flex; align-items: center; justify-content: center; }
  .mark svg { width: 22px; height: 22px; fill: #2c2e2a; }
  .brand-name { font-size: 22px; font-weight: 800; letter-spacing: -0.01em; }
  .brand-sub { font-size: 12px; color: #80827f; margin-bottom: 22px; }
  .steps { display: flex; justify-content: center; gap: 8px; margin-bottom: 24px; }
  .step { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; color: #80827f; }
  .step .n { width: 22px; height: 22px; border-radius: 50%; background: #eeeee8;
             display: flex; align-items: center; justify-content: center; font-size: 11px; }
  .step.on { color: #2c2e2a; }
  .step.on .n { background: #8ed462; color: #2c2e2a; }
  .step.done .n { background: #2e6c00; color: #fff; }
  .spinner { width: 44px; height: 44px; margin: 0 auto 18px; border-radius: 50%;
             border: 5px solid #e0dbce; border-top-color: #8ed462;
             animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #status { font-size: 15px; line-height: 1.6; min-height: 48px; }
  #status.ok { color: #2e6c00; font-weight: 700; }
  #status.err { color: #ba1a1a; }
  #status .dim { color: #80827f; font-size: 13px; }
  .check { width: 64px; height: 64px; margin: 0 auto 16px; border-radius: 50%;
           background: #8ed462; display: flex; align-items: center;
           justify-content: center; font-size: 30px; font-weight: 800; }
  .reassure { margin-top: 22px; padding-top: 18px; border-top: 1px solid rgba(44,46,42,0.08);
              font-size: 12.5px; color: #80827f; }
  .reassure b { color: #2e6c00; }
`;
const FLAME_SVG = `<svg viewBox="0 0 24 24"><path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z"/></svg>`;

app.get('/sign', (c) =>
  c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sol Burn — sign in Phantom</title>
<style>${SIGN_CSS}</style>
</head>
<body>
  <div class="card">
    <div class="brand"><span class="mark">${FLAME_SVG}</span><span class="brand-name">Sol Burn</span></div>
    <div class="brand-sub">Rent Recovery · secure signing</div>
    <div class="steps">
      <span class="step" id="st1"><span class="n">1</span>Connect</span>
      <span class="step" id="st2"><span class="n">2</span>Review</span>
      <span class="step" id="st3"><span class="n">3</span>Sign</span>
    </div>
    <div id="spin" class="spinner"></div>
    <div id="status">Loading…</div>
    <div class="reassure">This page <b>can't move your funds</b>.<br/>Only you sign, in Phantom.</div>
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
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getTokenAccountsByOwner',
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
