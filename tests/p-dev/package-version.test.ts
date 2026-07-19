import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  P_DEV_PACKAGE_VERSION_ENV,
  readHarnessPackageVersion,
  resolveHarnessPackageVersion,
  validatePackagedRuntimeVersionValue,
} from "../../src/p-dev/package-version.js";

describe("p-dev package version resolution", () => {
  const originalRuntimeMode = process.env.P_DEV_RUNTIME_MODE;
  const originalPackagedVersion = process.env[P_DEV_PACKAGE_VERSION_ENV];

  beforeEach(() => {
    delete process.env.P_DEV_RUNTIME_MODE;
    delete process.env[P_DEV_PACKAGE_VERSION_ENV];
  });

  afterEach(() => {
    if (originalRuntimeMode === undefined) {
      delete process.env.P_DEV_RUNTIME_MODE;
    } else {
      process.env.P_DEV_RUNTIME_MODE = originalRuntimeMode;
    }
    if (originalPackagedVersion === undefined) {
      delete process.env[P_DEV_PACKAGE_VERSION_ENV];
    } else {
      process.env[P_DEV_PACKAGE_VERSION_ENV] = originalPackagedVersion;
    }
  });

  it("reads the source harness package version outside packaged runtime", () => {
    const version = resolveHarnessPackageVersion();
    expect(version).toBe(readHarnessPackageVersion());
    expect(version).toBe("0.4.0");
  });

  it("requires packaged runtime version context", () => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";
    expect(() => resolveHarnessPackageVersion()).toThrow(
      `${P_DEV_PACKAGE_VERSION_ENV} is required in packaged p-dev runtime.`,
    );
  });

  it("reports the launcher-provided packaged version", () => {
    process.env.P_DEV_RUNTIME_MODE = "packaged";
    process.env[P_DEV_PACKAGE_VERSION_ENV] = "0.3.0";
    expect(resolveHarnessPackageVersion()).toBe("0.3.0");
  });

  it("rejects malformed packaged version values", () => {
    expect(() => validatePackagedRuntimeVersionValue("not-a-version")).toThrow(
      `${P_DEV_PACKAGE_VERSION_ENV} must be a valid package version string.`,
    );
  });
});
