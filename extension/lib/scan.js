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

export function formatSolExact(lamports) {
  // Full precision for the hero number: every lamport counts when it's yours.
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export function shortSol(lamports) {
  // Badge text: 4 chars max ("0.42", "12.3"). Empty when nothing trapped.
  if (lamports <= 0n) return '';
  const s = formatSol(lamports);
  if (s.length <= 4) return s;
  const [whole] = s.split('.');
  return whole.length >= 4 ? whole.slice(0, 4) : s.slice(0, 4);
}

async function scanProgram(owner, programId, rpc) {
  // getTokenAccountsByOwner is the right call here: it queries by owner
  // directly (no whole-program scan), so Helius doesn't hit its
  // getProgramAccounts large-result guard. jsonParsed gives mint + amount
  // without manual byte parsing; data.space (165/182) drives the rent math.
  const res = await rpc('getTokenAccountsByOwner', [
    owner,
    { programId },
    { encoding: 'jsonParsed' },
  ]);
  const accounts = res && Array.isArray(res.value) ? res.value : [];

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
    const parsed = account && account.data && account.data.parsed;
    if (!parsed || parsed.type !== 'account' || !parsed.info) continue;
    const info = parsed.info;
    const amount = BigInt(info.tokenAmount.amount);
    const lamports = BigInt(account.lamports);
    const space = account.data.space || 165;

    if (amount === 0n) {
      if (lamports > 0n) {
        dead.push({ pubkey, program: programId, mint: shortKey(info.mint), lamports });
      }
    } else {
      const rentExempt = await rentExemptFor(space);
      if (lamports > rentExempt + SURPLUS_DUST_LAMPORTS) {
        surplus.push({
          pubkey,
          program: programId,
          mint: shortKey(info.mint),
          lamports,
          withdrawable: lamports - rentExempt,
        });
      }
    }
  }
  return { dead, surplus };
}

export async function scanWallet(owner, rpc) {
  const [token, token2022] = await Promise.all([
    scanProgram(owner, TOKEN_PROGRAM_ID, rpc),
    scanProgram(owner, TOKEN_2022_PROGRAM_ID, rpc),
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
