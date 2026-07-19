export const MIN_NODE_MAJOR = 22;

export interface NodeVersionCheckResult {
  ok: boolean;
  message?: string;
}

export function parseNodeMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version.trim());
  if (!match?.[1]) {
    return Number.NaN;
  }
  return Number.parseInt(match[1], 10);
}

export function checkNodeVersion(
  version = process.version,
  minMajor = MIN_NODE_MAJOR,
): NodeVersionCheckResult {
  const major = parseNodeMajor(version);
  if (!Number.isFinite(major)) {
    return {
      ok: false,
      message: `Could not parse Node.js version from "${version}".`,
    };
  }

  if (major < minMajor) {
    return {
      ok: false,
      message: `p-dev requires Node.js ${minMajor}+. The active version is ${version}. Install a supported Node release and retry.`,
    };
  }

  return { ok: true };
}

export function assertNodeVersion(
  version = process.version,
  minMajor = MIN_NODE_MAJOR,
): void {
  const result = checkNodeVersion(version, minMajor);
  if (!result.ok) {
    throw new Error(result.message);
  }
}
