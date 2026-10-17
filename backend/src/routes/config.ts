import { Router, Request, Response } from 'express';

const router = Router();

/**
 * GET /config
 * Public client config: fee wallet, fee rate, referral economics,
 * and whether the first cleanup is fee-free.
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    feeWallet: process.env.FEE_WALLET || null,
    feeBps: Number(process.env.FEE_BPS || 3000),
    referrerBpsOfFee: Number(process.env.REFERRER_BPS_OF_FEE || 1667),
    firstClaimFree: (process.env.FIRST_CLAIM_FREE || 'true') === 'true',
    rpcProxy: '/rpc',
  });
});

export default router;
