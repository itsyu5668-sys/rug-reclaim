import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const bs58Codec = (bs58 as any).default ?? bs58;

/** Verify an ed25519 signature from a Solana wallet over a UTF-8 message. */
export function verifySignature(
  wallet: string,
  message: string,
  signatureBase58: string,
): boolean {
  try {
    const pubkey = new PublicKey(wallet);
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes =
      typeof bs58Codec.decode === 'function'
        ? bs58Codec.decode(signatureBase58)
        : (bs58 as any).decode(signatureBase58);
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubkey.toBytes());
  } catch {
    return false;
  }
}

export function isValidAddress(addr: string): boolean {
  try {
    new PublicKey(addr);
    return true;
  } catch {
    return false;
  }
}
