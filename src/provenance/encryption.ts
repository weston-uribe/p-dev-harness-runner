import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CursorProvenanceError } from "./errors.js";

export { hashProviderIdentity } from "../identity/provider-identity-hash.js";

export const PROVENANCE_KEY_ENV = "P_DEV_PROVENANCE_KEY_V1";
export const PROVENANCE_KEY_ID_V1 = "provenance-key-v1";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface EncryptionEnvelope {
  keyId: typeof PROVENANCE_KEY_ID_V1;
  algorithm: "aes-256-gcm";
  nonceB64url: string;
  ciphertextB64url: string;
  tagB64url: string;
  aadPurpose: string;
}

export interface EncryptAad {
  schemaKind: string;
  launchAttemptId: string;
  eventType: string;
  fieldPurpose: string;
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function encodeAad(aad: EncryptAad): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaKind: aad.schemaKind,
      launchAttemptId: aad.launchAttemptId,
      eventType: aad.eventType,
      fieldPurpose: aad.fieldPurpose,
    }),
    "utf8",
  );
}

export function parseProvenanceKey(
  raw: string | undefined | null,
): Buffer {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new CursorProvenanceError(
      "cursor_provenance_encryption_unavailable",
      "Provenance encryption key is missing.",
    );
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else {
    try {
      key = fromB64url(trimmed);
    } catch {
      throw new CursorProvenanceError(
        "cursor_provenance_encryption_unavailable",
        "Provenance encryption key format is invalid.",
      );
    }
  }
  if (key.length !== KEY_BYTES) {
    throw new CursorProvenanceError(
      "cursor_provenance_encryption_unavailable",
      "Provenance encryption key must be 32 bytes.",
    );
  }
  return key;
}

export function resolveProvenanceKeyFromEnv(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  return parseProvenanceKey(env[PROVENANCE_KEY_ENV]);
}

export function encryptProviderIdentity(
  plaintext: string,
  key: Buffer,
  aad: EncryptAad,
): EncryptionEnvelope {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const aadBuf = encodeAad(aad);
  cipher.setAAD(aadBuf);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    keyId: PROVENANCE_KEY_ID_V1,
    algorithm: "aes-256-gcm",
    nonceB64url: b64url(nonce),
    ciphertextB64url: b64url(ciphertext),
    tagB64url: b64url(tag),
    aadPurpose: aad.fieldPurpose,
  };
}

/** Restricted recovery tooling only — not used by importer/GUI join. */
export function decryptProviderIdentity(
  envelope: EncryptionEnvelope,
  key: Buffer,
  aad: EncryptAad,
): string {
  if (envelope.algorithm !== "aes-256-gcm") {
    throw new CursorProvenanceError(
      "cursor_provenance_encryption_unavailable",
      "Unsupported encryption algorithm.",
    );
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    fromB64url(envelope.nonceB64url),
  );
  decipher.setAAD(encodeAad(aad));
  decipher.setAuthTag(fromB64url(envelope.tagB64url));
  const plaintext = Buffer.concat([
    decipher.update(fromB64url(envelope.ciphertextB64url)),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export function envelopeMetadataForDigest(envelope: EncryptionEnvelope): {
  keyId: string;
  algorithm: string;
  aadPurpose: string;
} {
  return {
    keyId: envelope.keyId,
    algorithm: envelope.algorithm,
    aadPurpose: envelope.aadPurpose,
  };
}
