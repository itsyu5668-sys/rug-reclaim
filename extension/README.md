# Sol Burn — Chrome extension

One-click recovery of SOL locked in dead token accounts. Read-only scan first — the user sees the number before signing anything.

## Design

Warm storybook editorial (cream `#f5f1e4` + fresh grass `#8ed462`, Inter/system font, pill buttons, rounded cards). All 8 popup screens + landing page were designed by Francis; this repo implements them pixel-close with self-contained CSS (no CDN — MV3 forbids remote code).

## What's in here

| File | Does |
|---|---|
| `manifest.json` | MV3. Permissions: `storage`, `alarms`, `notifications` + host permissions for Solana RPC, our API, and CoinGecko (price estimates). `externally_connectable` limited to our API domain for the signer tab. No content scripts, no `<all_urls>`, no `tabs`. |
| `popup/` | All 8 screens: scan, scanning, results (money screen), claiming pipeline, claim complete, empty, error, settings. Bundled via esbuild → `popup.bundle.js`. |
| `background.js` | Service worker: 6h rescan alarms, toolbar badge, threshold notifications, signer-tab message bridge, claim logging to backend. |
| `lib/scan.js` | `scanWallet(owner, rpc)`: `getProgramAccounts` on Token + Token-2022; dead accounts (zero balance) + excess rent surplus on live accounts (SIMD-0437). Never hardcodes lamport values. |
| `lib/claim-tx.js` | Builds batched close transactions (20/batch) with the in-tx fee split. Unit-tested. |
| `lib/api.js` | Backend API client (config, claims, referrals, stats). |
| `src/signer.js` | Signer tab logic, bundled to `../worker/src/static/signer.bundle.txt` and served by the backend at `/sign`. |

## Screens

1. **Scan** — paste address, read-only, no connection needed
2. **Scanning** — spinner
3. **Results** — hero number, breakdown card, ONE fee line, referral collapse, reclaim CTA
4. **Claiming** — transaction pipeline with per-tx progress
5. **Done** — success + auto-rescan
6. **Empty** — habit-loop copy + badge explanation
7. **Error** — offline/scan-failed states with diagnostics
8. **Settings** — alert threshold, RPC endpoint, reset

## Build

```bash
npm install
node build.mjs   # → popup/popup.bundle.js + ../worker/src/static/signer.bundle.txt
```

## Try it

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Click the icon, paste a Solana address, hit Scan.
3. Hit Reclaim → signer tab opens → approve in Phantom.

## Trust notes

- Read-only scan first — nothing to sign until the user sees the number.
- Fee (30% after first free cleanup) shown exactly once in the popup + in Phantom's tx preview.
- Repo is public; no remote code; crypto utilities are explicitly allowed on the store.
