// Read-only wallet scan. No wallet connection, no signatures —
// this is the trust feature: the user sees the number before any approval.
//
// Two buckets per the build plan:
//   1. Dead token accounts (zero token balance) -> full lamports recoverable via close.
//   2. Excess rent surplus on LIVE accounts (SIMD-0437): lamports locked above the
//      current rent-exempt minimum are withdrawable WITHOUT closing the account.
//      This bucket grows with every future rent stage, hedging the flow cliff.
//
// SPL Token account layout (also the prefix of Token-2022 accounts):
//   bytes 0..32  mint, 32..64 owner, 64..72 amount (u64 LE)

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const LAMPORTS_PER_SOL = 1_000_000_000n;

// Ignore surplus smaller than this — not worth the user's attention or an instruction.
const SURPLUS_DUST_LAMPORTS = 1000n;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function readU64LE(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(
    offset,
    true
  );
}

function shortKey(pubkey) {
  return pubkey.length > 12 ? `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}` : pubkey;
}

export function formatSol(lamports) {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac.slice(0, 4) : ''}`;
}

export function shortSol(lamports) {
  // Badge text: 4 chars max ("0.42", "12.3"). Empty when nothing trapped.
  if (lamports <= 0n) return '';
  const s = formatSol(lamports);
  if (s.length <= 4) return s;
  const [whole] = s.split('.');
  return whole.length >= 4 ? whole.slice(0, 4) : s.slice(0, 4);
}

async function scanProgram(owner, programId, rpc, dataSize) {
  const filters = [{ memcmp: { offset: 32, bytes: owner } }];
  if (dataSize) filters.unshift({ dataSize });

  const accounts = await rpc('getProgramAccounts', [
    programId,
    { encoding: 'base64', filters },
  ]);

  const dead = [];
  const surplus = [];
  // Rent-exempt minimum depends only on account byte length (165 or 182),
  // so memoize it — a heavy trader has hundreds of accounts.
  const rentCache = new Map();
  const rentExemptFor = async (len) => {
    if (!rentCache.has(len)) {
      rentCache.set(len, BigInt(await rpc('getMinimumBalanceForRentExemption', [len])));
    }
    return rentCache.get(len);
  };

  for (const { pubkey, account } of accounts) {
    const bytes = b64ToBytes(account.data[0]);
    if (bytes.length < 72) continue; // not a token account shape; skip
    const amount = readU64LE(bytes, 64);
    const lamports = BigInt(account.lamports);

    if (amount === 0n) {
      if (lamports > 0n) {
        dead.push({ pubkey, program: programId, mint: shortKey(bytesToBase58(bytes, 0, 32)), lamports });
      }
    } else {
      const rentExempt = await rentExemptFor(bytes.length);
      if (lamports > rentExempt + SURPLUS_DUST_LAMPORTS) {
        surplus.push({
          pubkey,
          program: programId,
          mint: shortKey(bytesToBase58(bytes, 0, 32)),
          lamports,
          withdrawable: lamports - rentExempt,
        });
      }
    }
  }
  return { dead, surplus };
}

// base58 encode of a byte slice — dependency-free (Bitcoin alphabet).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bytesToBase58(bytes, offset, len) {
  let num = 0n;
  for (let i = offset; i < offset + len; i++) num = (num << 8n) | BigInt(bytes[i]);
  let out = '';
  while (num > 0n) {
    out = B58[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (let i = offset; i < offset + len && bytes[i] === 0; i++) out = '1' + out;
  return out;
}

export async function scanWallet(owner, rpc) {
  // Token: fixed 165-byte accounts. Token-2022: 165 or 182 (extensions) —
  // amount sits at the same offset either way, so no dataSize filter there.
  const [token, token2022] = await Promise.all([
    scanProgram(owner, TOKEN_PROGRAM_ID, rpc, 165),
    scanProgram(owner, TOKEN_2022_PROGRAM_ID, rpc, 0),
  ]);

  const dead = [...token.dead, ...token2022.dead];
  const surplus = [...token.surplus, ...token2022.surplus];

  const totalRecoverable = dead.reduce((s, a) => s + a.lamports, 0n);
  const totalSurplus = surplus.reduce((s, a) => s + a.withdrawable, 0n);

  return {
    owner,
    scannedAt: Date.now(),
    dead,
    surplus,
    deadCount: dead.length,
    totalRecoverable,
    totalSurplus,
    total: totalRecoverable + totalSurplus,
  };
}

export function isPlausibleAddress(s) {
  // Base58, 32-44 chars. Cheap client-side sanity check before hitting RPC.
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test((s || '').trim());
}
