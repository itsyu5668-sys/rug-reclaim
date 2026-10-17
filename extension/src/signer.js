// Signer tab. Served from the backend (/sign) and opened by the extension.
// It's a real https:// page, so Phantom injects window.phantom here —
// the one place an extension popup can't reach it. This tab:
//   1. reads the extension id from the URL fragment (#ext=<id>)
//   2. pulls the pending claim (unsigned txs) from the extension
//   3. connects Phantom, verifies the connected wallet matches the claim owner
//   4. optionally registers a referrer (signed message)
//   5. signs + sends each transaction, reporting progress back
//   6. shows the result and closes itself
//
// It never sees seed phrases or private keys. It only forwards signatures.

import { BrowserSDK, AddressType } from '@phantom/browser-sdk';
import { Transaction } from '@solana/web3.js';

const $ = (id) => document.getElementById(id);

// Minimal base58 encoder (Bitcoin alphabet) — the backend verifies
// referral signatures as base58, so the signature must be encoded as such.
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes) {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = '';
  while (num > 0n) {
    out = B58_ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

function setStatus(html, kind = '') {
  const el = $('status');
  el.innerHTML = html;
  el.className = kind;
}

function extId() {
  const m = /#ext=([a-z]+)/.exec(location.hash);
  return m ? m[1] : null;
}

async function talk(msg) {
  const id = extId();
  if (!id) throw new Error('missing extension id — open this page from the Rug Reclaim extension');
  return chrome.runtime.sendMessage(id, msg);
}

async function main() {
  try {
    setStatus('talking to the extension…');
    const claim = await talk({ type: 'getClaimRequest' });
    if (!claim || !claim.txs || !claim.txs.length) {
      throw new Error('nothing to sign — the claim expired. close this tab and hit Reclaim again.');
    }

    const { txs, owner, referrerToRegister, apiBase } = claim;

    setStatus('connecting to Phantom…');
    const sdk = new BrowserSDK({
      providers: ['injected'],
      addressTypes: [AddressType.solana],
    });
    if (!(await sdk.isPhantomInstalled())) {
      throw new Error('Phantom is not installed. install it from the Chrome Web Store, then try again.');
    }
    const { addresses } = await sdk.connect({ provider: 'injected' });
    const connected = addresses.find((a) => a.addressType === 'solana')?.address;
    if (!connected) throw new Error('no Solana address came back from Phantom');
    if (connected !== owner) {
      throw new Error(
        `wrong wallet connected (${connected.slice(0, 6)}…). ` +
          `this claim is for ${owner.slice(0, 6)}… — switch accounts in Phantom and reload.`,
      );
    }

    // Optional: register the referrer before claiming (signed message, one tap).
    if (referrerToRegister) {
      try {
        setStatus('registering your referrer…');
        const message = `rug-reclaim:referral:${referrerToRegister}:${Math.floor(Date.now() / 1000)}`;
        const { signature } = await sdk.solana.signMessage(message);
        const sigB58 = base58Encode(signature);
        await talk({ type: 'registerReferral', body: { wallet: owner, referrer: referrerToRegister, message, signature: sigB58 } });
      } catch (err) {
        // Non-fatal: referral skipped, claim still goes through.
        console.warn('[rug-reclaim] referral registration skipped:', err.message);
      }
    }

    const signatures = [];
    for (let i = 0; i < txs.length; i++) {
      setStatus(
        `signing transaction ${i + 1} of ${txs.length}…<br><span class="dim">check the Phantom preview — the fee is listed there</span>`,
      );
      const tx = Transaction.from(Buffer.from(txs[i].base64, 'base64'));
      const { signature } = await sdk.solana.signAndSendTransaction(tx);
      signatures.push(signature);
      await talk({ type: 'claimProgress', done: i + 1, total: txs.length, signature });
    }

    await talk({ type: 'claimComplete', signatures });
    setStatus(
      `done — ${signatures.length} transaction${signatures.length > 1 ? 's' : ''} confirmed.<br>` +
        `<span class="dim">this tab closes in a few seconds</span>`,
      'ok',
    );
    setTimeout(() => window.close(), 4000);
  } catch (err) {
    console.error('[rug-reclaim] signer failed:', err);
    setStatus(`something went wrong:<br><b>${escapeHtml(err.message)}</b>`, 'err');
    try {
      await talk({ type: 'claimFailed', error: err.message });
    } catch {}
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.addEventListener('DOMContentLoaded', main);
