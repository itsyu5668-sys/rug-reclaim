// Minimal JSON-RPC client for Solana. Zero dependencies on purpose:
// MV3 forbids remote code, so everything the extension needs is bundled here.

import { API_BASE } from './api.js';

// Default route: our worker's /rpc proxy. The public Solana endpoint 403s
// browser-origin requests for getProgramAccounts, so calling it direct from
// the popup fails. The proxy calls Solana server-side (no Origin header).
export const DEFAULT_RPC_ENDPOINT = `${API_BASE}/rpc`;
export const DIRECT_RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';

export function createRpc(endpoint) {
  let id = 1;
  const url = endpoint || DEFAULT_RPC_ENDPOINT;
  return async function rpc(method, params) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status} calling ${method}`);
    const json = await res.json();
    if (json.error) {
      throw new Error(
        `RPC error calling ${method}: ${json.error.message || JSON.stringify(json.error)}`
      );
    }
    return json.result;
  };
}
