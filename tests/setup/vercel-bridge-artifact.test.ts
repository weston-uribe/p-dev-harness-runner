import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildVercelBridgeArtifactFiles } from "../../src/setup/vercel-bridge-artifact.js";

describe("vercel bridge artifact", () => {
  it("generates syntactically valid JS with working issue-key regex", () => {
    const files = buildVercelBridgeArtifactFiles();
    const js = files.find((file) => file.file.endsWith(".js"));
    expect(js).toBeDefined();
    if (!js) {
      return;
    }

    const dir = mkdtempSync(path.join(tmpdir(), "bridge-artifact-"));
    const filePath = path.join(dir, "linear-webhook.js");
    writeFileSync(filePath, js.data, "utf8");
    execFileSync(process.execPath, ["--check", filePath], { stdio: "pipe" });

    expect(js.data).toContain("function issueKeyFromUrl");
    expect(js.data).toContain('.split(/[,\\s]+/)');
    expect(js.data).toContain("ensureOpaqueDispatch");
    expect(js.data).toContain("resolveLinearIssueIdByIdentifier");
    const vercelJson = files.find((file) => file.file === "vercel.json");
    expect(vercelJson?.data).toContain('"maxDuration": 30');
    // Broken String.raw regex literal form that crashed production.
    expect(js.data).not.toMatch(/url\.match\(\/\\\/\(/);

    const re = new RegExp("/([A-Z]+-" + "\\d+" + ")(?:/|$|#)");
    expect(re.exec("https://linear.app/team/issue/FRE-3/title")?.[1]).toBe("FRE-3");

    const line = js.data.split("\n").find((entry) => entry.includes("new RegExp"));
    expect(line).toBeTruthy();
    const expr = line!.replace(/^\s*const match = url\.match\(/, "").replace(/\);\s*$/, "");
    const compiled = eval(expr) as RegExp;
    expect(
      "https://linear.app/team/issue/FRE-3/title".match(compiled)?.[1],
    ).toBe("FRE-3");
  });
});
