-- Rug Reclaim backend tables.
-- Run this once in the Supabase dashboard SQL editor
-- (project tkgotpzqwasttopwsxpd). Safe to re-run.

create table if not exists public.rug_referrals (
  id bigint generated always as identity primary key,
  wallet text not null,
  referrer text not null,
  created_at timestamptz not null default now(),
  constraint rug_referrals_wallet_unique unique (wallet),
  constraint rug_referrals_no_self check (wallet <> referrer)
);

create table if not exists public.rug_claims (
  id bigint generated always as identity primary key,
  wallet text not null,
  tx_signature text not null,
  accounts_closed integer not null default 0,
  lamports_reclaimed bigint not null default 0,
  fee_lamports bigint not null default 0,
  referrer_fee_lamports bigint not null default 0,
  referrer text,
  created_at timestamptz not null default now(),
  constraint rug_claims_tx_unique unique (tx_signature)
);

create index if not exists rug_claims_wallet_idx on public.rug_claims (wallet);
create index if not exists rug_referrals_referrer_idx on public.rug_referrals (referrer);

-- The backend uses the service_role key (bypasses RLS), so no policies needed.
-- Do NOT expose these tables via the anon key.
