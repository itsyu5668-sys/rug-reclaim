import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

/** Verify an ed25519 signature from a Solana wallet over a UTF-8 message. */
export function verifySignature(
  wallet: string,
  message: string,
  signatureBase58: string,
): boolean {
  try {
    const pubkey = new PublicKey(wallet);
    const msgBytes = new TextEncoder().encode(message);
    const decode = (bs58 as any).decode ?? (bs58 as any).default?.decode;
    const sigBytes = decode(signatureBase58);
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
