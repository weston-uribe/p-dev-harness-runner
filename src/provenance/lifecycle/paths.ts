/** Canonical state-repo paths for coverage lifecycle artifacts. */

export const PROVENANCE_STATE_ROOT =
  ".p-dev/cursor-cloud-agent-provenance" as const;

export const ACTIVATION_RECORD_PATH = `${PROVENANCE_STATE_ROOT}/activation/record.json`;

export const ACTIVATION_HISTORY_PROOF_PATH = `${PROVENANCE_STATE_ROOT}/activation/history-proof.json`;

export const COVERAGE_SNAPSHOT_PATH = `${PROVENANCE_STATE_ROOT}/coverage/snapshot.json`;

export const COVERAGE_SEAL_PATH = `${PROVENANCE_STATE_ROOT}/coverage/seal.json`;

export const COVERAGE_INVALIDATION_DIR = `${PROVENANCE_STATE_ROOT}/coverage/invalidations`;

export const COVERAGE_SUPERSESSION_DIR = `${PROVENANCE_STATE_ROOT}/coverage/supersessions`;

export const COVERAGE_GAP_DIR = `${PROVENANCE_STATE_ROOT}/coverage/gaps`;
