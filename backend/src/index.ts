import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import configRoutes from './routes/config.js';
import referralRoutes from './routes/referrals.js';
import claimRoutes from './routes/claims.js';
import rpcRoutes from './routes/rpc.js';
import statsRoutes from './routes/stats.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / server-to-server
      const ok = allowed.some((pat) =>
        pat.endsWith('*') ? origin.startsWith(pat.slice(0, -1)) : origin === pat,
      );
      cb(null, ok || allowed.length === 0);
    },
  }),
);

app.get('/health', (_req, res) => res.json({ ok: true, service: 'rug-reclaim-backend' }));
app.use('/config', configRoutes);
app.use('/referrals', referralRoutes);
app.use('/claims', claimRoutes);
app.use('/rpc', rpcRoutes);
app.use('/stats', statsRoutes);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`rug-reclaim-backend listening on :${port}`));
