declare module "tweetsodium" {
  export function seal(
    message: Uint8Array | Buffer,
    publicKey: Uint8Array | Buffer,
  ): Uint8Array;

  export function sealOpen(
    ciphertext: Uint8Array | Buffer,
    publicKey: Uint8Array | Buffer,
    secretKey: Uint8Array | Buffer,
  ): Uint8Array | null;

  export const overheadLength: number;
}
