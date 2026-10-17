import { Router, Request, Response } from 'express';
import { db, dbConfigured } from '../db.js';

const router = Router();

/**
 * GET /stats — platform totals for the landing page / social proof.
 * Served from a materialized-ish aggregation over rug_claims.
 */
router.get('/', async (_req: Request, res: Response) => {
  if (!dbConfigured()) {
    return res.json({
      totalReclaimedLamports: 0,
      totalAccountsClosed: 0,
      totalClaims: 0,
      totalUsers: 0,
      live: false,
    });
  }

  const { data, error } = await db()
    .from('rug_claims')
    .select('lamports_reclaimed, accounts_closed, wallet');
  if (error) return res.status(500).json({ error: 'db error' });

  const rows = data ?? [];
  const users = new Set(rows.map((r) => r.wallet));
  res.json({
    totalReclaimedLamports: rows.reduce((s, r) => s + Number(r.lamports_reclaimed || 0), 0),
    totalAccountsClosed: rows.reduce((s, r) => s + Number(r.accounts_closed || 0), 0),
    totalClaims: rows.length,
    totalUsers: users.size,
    live: true,
  });
});

export default router;
