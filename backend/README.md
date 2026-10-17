# Rug Reclaim — Backend

API backend for the Rug Reclaim Chrome extension (one-click SOL rent recovery
for meme coin traders).

## What it does

| Route | Purpose |
|---|---|
| `GET /health` | Liveness check |
| `GET /config` | Public client config: fee wallet, fee bps (30%), referral economics, first-claim-free flag |
| `POST /rpc` | JSON-RPC proxy to Solana (keeps the RPC API key server-side; allow-listed methods only) |
| `POST /referrals/register` | Bind a wallet to a referrer (signed message, replay-protected, one per wallet) |
| `GET /referrals/:wallet` | Referrer + referral stats/earnings for a wallet |
| `POST /claims` | Log a completed cleanup (powers stats + referral earnings + first-claim-free) |
| `GET /claims/count/:wallet` | Has this wallet cleaned before? (first-claim-free check) |
| `GET /stats` | Platform totals for social proof |

## Money flow

The extension builds the close-account transactions client-side and appends a
transfer instruction in the same transaction:

- Normal claim: 70% → user, 25% → `FEE_WALLET`, 5% → referrer (when present)
- First claim per wallet: 100% → user (fee waived, `FIRST_CLAIM_FREE=true`)

All splits are atomic and visible in the wallet's transaction preview.

## Setup

1. Copy `.env.example` to `.env` and fill in `SUPABASE_SERVICE_KEY`, `FEE_WALLET`.
2. Run `supabase/migration.sql` once in the Supabase dashboard SQL editor.
3. `npm install && npm run build && npm start`

## Reference

Core Solana close-account logic is adapted from
[daronthedragon/solana-rent-reclaim](https://github.com/daronthedragon/solana-rent-reclaim)
(MIT licensed).
