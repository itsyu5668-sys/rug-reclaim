import { Router, Request, Response } from 'express';
import { db, dbConfigured } from '../db.js';
import { isValidAddress } from '../solana.js';

const router = Router();

/**
 * POST /claims
 * Body: { wallet, txSignature, accountsClosed, lamportsReclaimed,
 *         feeLamports, referrerFeeLamports, referrer }
 * Logged by the extension after a successful cleanup. Powers stats,
 * referral earnings, and the first-claim-free check.
 */
router.post('/', async (req: Request, res: Response) => {
  if (!dbConfigured()) return res.status(503).json({ error: 'database not configured' });

  const {
    wallet,
    txSignature,
    accountsClosed,
    lamportsReclaimed,
    feeLamports,
    referrerFeeLamports,
    referrer,
  } = req.body ?? {};

  if (!wallet || !txSignature || !isValidAddress(wallet)) {
    return res.status(400).json({ error: 'wallet and txSignature required' });
  }
  if (referrer && !isValidAddress(referrer)) {
    return res.status(400).json({ error: 'invalid referrer' });
  }

  const { error } = await db().from('rug_claims').insert({
    wallet,
    tx_signature: String(txSignature),
    accounts_closed: Number(accountsClosed) || 0,
    lamports_reclaimed: Number(lamportsReclaimed) || 0,
    fee_lamports: Number(feeLamports) || 0,
    referrer_fee_lamports: Number(referrerFeeLamports) || 0,
    referrer: referrer || null,
  });
  if (error) {
    // Duplicate tx signature: already logged, treat as ok.
    if ((error as any).code === '23505') return res.json({ ok: true, duplicate: true });
    return res.status(500).json({ error: 'db error' });
  }
  res.json({ ok: true });
});

/**
 * GET /claims/count/:wallet — has this wallet cleaned before?
 * Used by the extension to apply the first-claim-free rule.
 */
router.get('/count/:wallet', async (req: Request, res: Response) => {
  if (!dbConfigured()) return res.status(503).json({ error: 'database not configured' });
  const { wallet } = req.params;
  if (!isValidAddress(wallet)) return res.status(400).json({ error: 'invalid address' });
  const { count } = await db()
    .from('rug_claims')
    .select('id', { count: 'exact', head: true })
    .eq('wallet', wallet);
  res.json({ count: count ?? 0 });
});

export default router;
