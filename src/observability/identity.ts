import { randomUUID } from "node:crypto";

export function generateSessionId(): string {
  return randomUUID();
}

export function generateInstallationId(): string {
  return randomUUID();
}

export function generateObservabilityNonce(): string {
  return randomUUID();
}
