/**
 * Restricted recovery tooling for decrypting provider identities.
 * Not used by importer/GUI join paths.
 */

import {
  decryptProviderIdentity,
  type EncryptionEnvelope,
  parseProvenanceKey,
  PROVENANCE_KEY_ENV,
} from "./encryption.js";
import { PROVENANCE_EVENT_SCHEMA_KIND } from "./events.js";

export function recoverProviderIdentity(input: {
  envelope: EncryptionEnvelope;
  launchAttemptId: string;
  eventType: string;
  fieldPurpose: string;
  keyMaterial?: string;
  env?: Record<string, string | undefined>;
}): string {
  const env = input.env ?? process.env;
  const key = parseProvenanceKey(
    input.keyMaterial ?? env[PROVENANCE_KEY_ENV],
  );
  return decryptProviderIdentity(input.envelope, key, {
    schemaKind: PROVENANCE_EVENT_SCHEMA_KIND,
    launchAttemptId: input.launchAttemptId,
    eventType: input.eventType,
    fieldPurpose: input.fieldPurpose,
  });
}
