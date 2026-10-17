import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';

const router = Router();

// Generous but bounded: the extension scans through this proxy.
const limiter = rateLimit({ windowMs: 60_000, max: 600 });
router.use(limiter);

const ALLOW_METHODS = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlockhash',
  'getLatestBlockhash',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getSignatureStatuses',
  'getSlot',
  'getTokenAccountBalance',
  'sendRawTransaction',
  'simulateTransaction',
]);

/**
 * POST /rpc — JSON-RPC proxy to the configured Solana RPC.
 * Keeps the RPC API key server-side; the extension never sees it.
 * Only read/send methods are allowed — no admin or account-writing calls.
 */
router.post('/', async (req: Request, res: Response) => {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) return res.status(503).json({ error: 'RPC not configured' });

  const { method, params, id } = req.body ?? {};
  if (typeof method !== 'string' || !ALLOW_METHODS.has(method)) {
    return res.status(400).json({ error: 'method not allowed' });
  }

  try {
    const upstream = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: id ?? 1,
        method,
        params: params ?? [],
      }),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch {
    res.status(502).json({ error: 'upstream RPC error' });
  }
});

export default router;
