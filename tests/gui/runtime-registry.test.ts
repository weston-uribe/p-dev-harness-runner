import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupStaleRegistryRecords,
  computeRegistryIdentityHash,
  createRegistryRecord,
  listRegistryRecords,
  readRegistryRecord,
  removeRegistryRecord,
  resolveRegistryRecordPath,
  writeRegistryRecord,
} from "../../src/gui/runtime-registry.js";

describe("runtime registry", () => {
  let registryRoot = "";

  beforeEach(async () => {
    registryRoot = await mkdtemp(path.join(tmpdir(), "p-dev-registry-"));
  });

  afterEach(async () => {
    await rm(registryRoot, { recursive: true, force: true });
  });

  it("does not expose an HTTP API and stores records under TMPDIR", async () => {
    const record = createRegistryRecord({
      sourceRoot: "/src",
      workspaceDir: "/workspace",
      host: "localhost",
      port: 3000,
      pid: process.pid,
    });
    const recordPath = await writeRegistryRecord(record, { registryRoot });
    expect(recordPath.startsWith(registryRoot)).toBe(true);
    expect(recordPath).toContain("p-dev/gui-servers");
    const stored = await readRegistryRecord(recordPath);
    expect(stored?.workspaceDir).toBe(path.resolve("/workspace"));
  });

  it("removes stale registry records", async () => {
    const record = createRegistryRecord({
      sourceRoot: "/src",
      workspaceDir: "/workspace",
      host: "localhost",
      port: 3000,
      pid: 999_999,
      instanceId: "stale",
    });
    await writeRegistryRecord(record, { registryRoot });
    const removed = await cleanupStaleRegistryRecords({
      registryRoot,
      now: () => Date.now() + 25 * 60 * 60 * 1000,
    });
    expect(removed).toBe(1);
    expect(await listRegistryRecords(registryRoot)).toHaveLength(0);
  });

  it("removes only matching instance records", async () => {
    const record = createRegistryRecord({
      sourceRoot: "/src",
      workspaceDir: "/workspace",
      host: "localhost",
      port: 3000,
      pid: process.pid,
      instanceId: "instance-a",
    });
    await writeRegistryRecord(record, { registryRoot });
    const removedWrong = await removeRegistryRecord({
      sourceRoot: "/src",
      workspaceDir: "/workspace",
      instanceId: "instance-b",
      registryRoot,
    });
    expect(removedWrong).toBe(false);
    const removed = await removeRegistryRecord({
      sourceRoot: "/src",
      workspaceDir: "/workspace",
      instanceId: "instance-a",
      registryRoot,
    });
    expect(removed).toBe(true);
  });

  it("hashes source and workspace identity", () => {
    const hash = computeRegistryIdentityHash({
      sourceRoot: "/src",
      workspaceDir: "/workspace",
    });
    expect(hash).toHaveLength(64);
    expect(
      computeRegistryIdentityHash({
        sourceRoot: "/src",
        workspaceDir: "/other",
      }),
    ).not.toBe(hash);
  });

  it("resolves deterministic record paths", () => {
    const recordPath = resolveRegistryRecordPath({
      sourceRoot: "/src",
      workspaceDir: "/workspace",
      registryRoot,
    });
    expect(recordPath.endsWith(".json")).toBe(true);
  });
});
