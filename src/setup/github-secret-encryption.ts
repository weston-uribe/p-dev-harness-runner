import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { seal } = require("tweetsodium") as {
  seal: (message: Uint8Array, publicKey: Uint8Array) => Uint8Array;
};

export function encryptGitHubActionsSecret(
  secretValue: string,
  publicKeyBase64: string,
): string {
  const messageBytes = Buffer.from(secretValue, "utf8");
  const publicKeyBytes = Buffer.from(publicKeyBase64, "base64");
  const encryptedBytes = seal(messageBytes, publicKeyBytes);
  return Buffer.from(encryptedBytes).toString("base64");
}
