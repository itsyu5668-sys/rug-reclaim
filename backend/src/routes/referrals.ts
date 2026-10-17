import { Router, Request, Response } from 'express';
import { db, dbConfigured } from '../db.js';
import { isValidAddress, verifySignature } from '../solana.js';

const router = Router();

/**
 * Referral message format the extension asks the wallet to sign:
 *   rug-reclaim:referral:<referrer>:<unix-seconds>
 * Timestamp must be within 10 minutes to prevent replay.
 */
function parseReferralMessage(message: string): { referrer: string; ts: number } | null {
  const m = /^rug-reclaim:referral:([1-9A-HJ-NP-Za-km-z]{32,44}):(\d+)$/.exec(message);
  if (!m) return null;
  return { referrer: m[1], ts: Number(m[2]) };
}

/**
 * POST /referrals/register
 * Body: { wallet, referrer, message, signature }
 * Binds a wallet to a referrer exactly once. Signature proves wallet ownership.
 */
router.post('/register', async (req: Request, res: Response) => {
  if (!dbConfigured()) return res.status(503).json({ error: 'database not configured' });

  const { wallet, referrer, message, signature } = req.body ?? {};
  if (!wallet || !referrer || !message || !signature) {
    return res.status(400).json({ error: 'wallet, referrer, message, signature required' });
  }
  if (!isValidAddress(wallet) || !isValidAddress(referrer)) {
    return res.status(400).json({ error: 'invalid address' });
  }
  if (wallet === referrer) {
    return res.status(400).json({ error: 'self-referral not allowed' });
  }
  const parsed = parseReferralMessage(message);
  if (!parsed || parsed.referrer !== referrer) {
    return res.status(400).json({ error: 'malformed message' });
  }
  if (Math.abs(Date.now() / 1000 - parsed.ts) > 600) {
    return res.status(400).json({ error: 'message expired' });
  }
  if (!verifySignature(wallet, message, signature)) {
    return res.status(401).json({ error: 'bad signature' });
  }

  const { data: existing } = await db()
    .from('rug_referrals')
    .select('id')
    .eq('wallet', wallet)
    .maybeSingle();
  if (existing) return res.status(409).json({ error: 'already registered' });

  const { error } = await db().from('rug_referrals').insert({ wallet, referrer });
  if (error) return res.status(500).json({ error: 'db error' });
  res.json({ ok: true });
});

/**
 * GET /referrals/:wallet
 * Returns this wallet's referrer (for in-transaction splits) plus
 * aggregate stats: how many they referred and what they earned.
 */
router.get('/:wallet', async (req: Request, res: Response) => {
  if (!dbConfigured()) return res.status(503).json({ error: 'database not configured' });
  const { wallet } = req.params;
  if (!isValidAddress(wallet)) return res.status(400).json({ error: 'invalid address' });

  const [{ data: mine }, { data: referred, count }] = await Promise.all([
    db().from('rug_referrals').select('referrer').eq('wallet', wallet).maybeSingle(),
    db()
      .from('rug_referrals')
      .select('wallet', { count: 'exact' })
      .eq('referrer', wallet),
  ]);

  const { data: earnings } = await db()
    .from('rug_claims')
    .select('referrer_fee_lamports')
    .eq('referrer', wallet);
  const earnedLamports = (earnings ?? []).reduce(
    (s, r) => s + Number(r.referrer_fee_lamports || 0),
    0,
  );

  res.json({
    referrer: mine?.referrer ?? null,
    referredCount: count ?? 0,
    referred: (referred ?? []).map((r) => r.wallet),
    earnedLamports,
  });
});

export default router;
