# Rug Reclaim — Chrome extension (scaffold, step 1 of the build plan)

Implements **step 1** of `~/workspace/your_files/sol-reclaim-build-plan.md` §7:
scaffold + read-only scan + popup showing the trapped number. **No wallet needed.**

## What's in here

| File | Does |
|---|---|
| `manifest.json` | MV3. Permissions: `storage`, `alarms`, `notifications` + RPC host only. No content scripts, no `<all_urls>`, no `tabs` — the extension never touches web pages, which keeps the Chrome Web Store review easy. |
| `popup/` | Scan-on-open UI. Paste any address → big trapped-SOL number → breakdown (dead accounts vs excess rent surplus on live accounts). Fee shown in the footer in plain words. "Reclaim" button is a disabled placeholder until step 2. |
| `background.js` | Service worker. Rescans the watched address every 6h, updates the toolbar badge (`0.42`-style trapped SOL), fires a threshold notification (default 0.05 SOL, upward-crossing only — every alert is a revenue event). |
| `lib/rpc.js` | Zero-dependency JSON-RPC client. |
| `lib/scan.js` | `scanWallet(owner, rpc)`: `getProgramAccounts` on Token + Token-2022 with `memcmp` owner filter; dead accounts (zero balance → full lamports recoverable); live accounts with `lamports > getMinimumBalanceForRentExemption(len)` → withdrawable surplus (SIMD-0437, per build plan §2a). Never hardcodes lamport values. |

## Try it

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Click the icon, paste a Solana address, hit Scan.
3. The badge on the toolbar updates with the trapped total.

## Still to do (steps 2–4 of the plan)

- **Step 2:** Phantom connect + batch `createCloseAccountInstruction` closes (+ `WithdrawExcessLamports` for surplus) + in-tx 30% fee split + first-cleanup-free via Supabase. Needs the **fee-wallet address** (open decision).
- **Step 3:** Referral links — `?ref=<wallet>` → signed `"sol-reclaim-referrer:<wallet>"` → wallet→referrer mapping → 70/25/5 in-tx split. Backend `/referrals` route already exists in `../worker`.
- **Step 4:** Threshold tuning, streak counter, rug alerts.
- **Step 5:** CWS assets (128px icon done — `icons/icon128.png`; still need screenshots + promo tile), privacy policy URL, submit.

## Config

- RPC endpoint: stored in `chrome.storage.local` as `rpcEndpoint`; defaults to `api.mainnet-beta.solana.com`. When you switch to Helius/QuickNode, **add its host to `host_permissions` in `manifest.json`** (MV3 requires declared hosts).
- Threshold: `thresholdSol` in storage, default `0.05`.

## Trust notes (for the listing, per plan §6)

- Read-only scan first — nothing to sign until the user sees the number.
- Fee (30% after first free cleanup) disclosed in the popup footer and, later, in the Phantom tx preview itself.
- Repo is public; no remote code; crypto utilities are explicitly allowed on the store.
