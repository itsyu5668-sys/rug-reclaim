// Minimal JSON-RPC client for Solana. Zero dependencies on purpose:
// MV3 forbids remote code, so everything the extension needs is bundled here.

export const DEFAULT_RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';

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
