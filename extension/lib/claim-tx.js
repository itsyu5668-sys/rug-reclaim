// Transaction building for claims. Bundled into the popup via esbuild.
//
// Fee model (matches backend /config):
//   - closes credit the user's wallet first, within the same tx
//   - then a SystemProgram.transfer sends the fee to the fee wallet
//   - with a referrer: fee splits feeWallet / referrer per referrerBpsOfFee
//   - first cleanup is free: no transfer instructions at all

import {
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { createCloseAccountInstruction } from '@solana/spl-token';
import { Buffer } from 'buffer';

export const MAX_CLOSES_PER_TX = 20;
const LAMPORTS_PER_SOL = 1000000000n;

export function formatSolBigint(lamports) {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac.slice(0, 4) : ''}`;
}

/**
 * @param {object} args
 * @param {Array<{pubkey:string, program:string, lamports:bigint|string}>} args.dead
 * @param {string} args.owner            user's wallet
 * @param {string} args.blockhash        recent blockhash (base58)
 * @param {string} args.feeWallet
 * @param {number} args.feeBps           e.g. 3000 = 30%
 * @param {string|null} args.referrer
 * @param {number} args.referrerBpsOfFee e.g. 1667 = 16.67% of the fee
 * @param {boolean} args.free            first cleanup free — no fee transfers
 * @returns {Array<{base64:string, accountsClosed:number, lamportsReclaimed:string, feeLamports:string, referrerFeeLamports:string}>}
 */
export function buildClaimTransactions({
  dead,
  owner,
  blockhash,
  feeWallet,
  feeBps,
  referrer,
  referrerBpsOfFee,
  free,
}) {
  const ownerPk = new PublicKey(owner);
  const feeWalletPk = new PublicKey(feeWallet);
  const referrerPk = referrer ? new PublicKey(referrer) : null;

  const batches = [];
  for (let i = 0; i < dead.length; i += MAX_CLOSES_PER_TX) {
    batches.push(dead.slice(i, i + MAX_CLOSES_PER_TX));
  }

  return batches.map((batch) => {
    const tx = new Transaction();
    let batchTotal = 0n;

    for (const acct of batch) {
      tx.add(
        createCloseAccountInstruction(
          new PublicKey(acct.pubkey),
          ownerPk, // destination: rent goes back to the user
          ownerPk, // authority
          [],
          new PublicKey(acct.program),
        ),
      );
      batchTotal += BigInt(acct.lamports);
    }

    let feeLamports = 0n;
    let referrerFeeLamports = 0n;

    if (!free && feeBps > 0) {
      const fee = (batchTotal * BigInt(feeBps)) / 10000n;
      if (fee > 0n) {
        if (referrerPk && referrerBpsOfFee > 0) {
          referrerFeeLamports = (fee * BigInt(referrerBpsOfFee)) / 10000n;
          const platformFee = fee - referrerFeeLamports;
          if (platformFee > 0n) {
            tx.add(
              SystemProgram.transfer({
                fromPubkey: ownerPk,
                toPubkey: feeWalletPk,
                lamports: platformFee,
              }),
            );
          }
          if (referrerFeeLamports > 0n) {
            tx.add(
              SystemProgram.transfer({
                fromPubkey: ownerPk,
                toPubkey: referrerPk,
                lamports: referrerFeeLamports,
              }),
            );
          }
          feeLamports = fee;
        } else {
          tx.add(
            SystemProgram.transfer({
              fromPubkey: ownerPk,
              toPubkey: feeWalletPk,
              lamports: fee,
            }),
          );
          feeLamports = fee;
        }
      }
    }

    tx.feePayer = ownerPk;
    tx.recentBlockhash = blockhash;

    const serialized = tx.serialize({ requireAllSignatures: false });
    return {
      base64: Buffer.from(serialized).toString('base64'),
      accountsClosed: batch.length,
      lamportsReclaimed: batchTotal.toString(),
      feeLamports: feeLamports.toString(),
      referrerFeeLamports: referrerFeeLamports.toString(),
    };
  });
}
