import { describe, expect, it } from "vitest";
import {
  createGuidedRepoRowId,
  guidedRowsFromConfig,
  guidedRowsToConfigRepos,
  isRepoFailedForActiveToken,
  isRepoVerifiedForActiveToken,
  isRepoVerifiedForUrl,
  isServiceFailedForValue,
  isServiceVerifiedForValue,
  resolveServiceConnectionBadgeState,
  resolveActiveGitHubToken,
  SAVED_GITHUB_TOKEN_FINGERPRINT,
  valueFingerprint,
} from "../../apps/gui/lib/verification-state.js";

describe("verification-state helpers", () => {
  it("creates stable fingerprints without exposing secret values", () => {
    const fingerprint = valueFingerprint("secret-token-value");
    expect(fingerprint).toMatch(/^fp:-?\d+:\d+$/);
    expect(fingerprint).not.toContain("secret-token-value");
  });

  it("detects service verification for the exact current value", () => {
    const token = "linear-token-abc";
    const verification = {
      state: "connected" as const,
      verifiedValueFingerprint: valueFingerprint(token),
      message: "Connected as Weston Uribe",
    };

    expect(isServiceVerifiedForValue(verification, token)).toBe(true);
    expect(isServiceVerifiedForValue(verification, "different-token")).toBe(
      false,
    );
  });

  it("detects failed service verification for the exact attempted value", () => {
    const token = "bad-token";
    const verification = {
      state: "failed" as const,
      attemptedValueFingerprint: valueFingerprint(token),
      message: "Linear rejected this key",
    };

    expect(isServiceFailedForValue(verification, token)).toBe(true);
    expect(isServiceFailedForValue(verification, "other-token")).toBe(false);
  });

  it("does not treat saved local credentials as connected without verification", () => {
    expect(
      resolveServiceConnectionBadgeState(
        true,
        { state: "unchecked" },
        "",
      ),
    ).toBe("unchecked");
  });

  it("uses server-seeded connected verification for saved credentials", () => {
    expect(
      resolveServiceConnectionBadgeState(
        true,
        { state: "connected", message: "Connected as Weston" },
        "",
      ),
    ).toBe("connected");
  });

  it("shows failed when saved credential verification fails in session", () => {
    expect(
      resolveServiceConnectionBadgeState(
        true,
        {
          state: "failed",
          attemptedValueFingerprint: valueFingerprint("bad-token"),
          message: "Linear rejected this key",
        },
        "",
      ),
    ).toBe("failed");
  });

  it("shows unchecked when no saved credential and no verification", () => {
    expect(
      resolveServiceConnectionBadgeState(
        false,
        { state: "unchecked" },
        "",
      ),
    ).toBe("unchecked");
  });

  it("detects repo verification for the exact current URL", () => {
    const url = "https://github.com/acme/my-product";
    const verification = {
      state: "connected" as const,
      verifiedTargetRepo: url,
      message: "Connected to acme/my-product",
    };

    expect(isRepoVerifiedForUrl(verification, url)).toBe(true);
    expect(
      isRepoVerifiedForUrl(
        verification,
        "https://github.com/acme/another-app",
      ),
    ).toBe(false);
  });

  it("creates guided repo rows with stable row ids", () => {
    const rows = guidedRowsFromConfig(
      {
        repos: [
          { id: "", targetRepo: "https://github.com/acme/repo-one" },
          { id: "", targetRepo: "https://github.com/acme/repo-two" },
        ],
      },
      1,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.rowId).toBeTruthy();
    expect(rows[1]?.rowId).toBeTruthy();
    expect(rows[0]?.rowId).not.toBe(rows[1]?.rowId);
    expect(guidedRowsToConfigRepos(rows)).toEqual([
      { id: "", targetRepo: "https://github.com/acme/repo-one" },
      { id: "", targetRepo: "https://github.com/acme/repo-two" },
    ]);
  });

  it("prefers the typed GitHub token over a saved local token", () => {
    const active = resolveActiveGitHubToken({
      typedToken: "ghp_new_token_value",
      hasSavedToken: true,
    });

    expect(active).toEqual({
      tokenForRequest: "ghp_new_token_value",
      source: "typed",
      fingerprint: valueFingerprint("ghp_new_token_value"),
    });
    expect(active?.fingerprint).not.toContain("ghp_new_token_value");
  });

  it("falls back to saved GitHub token only when no typed token exists", () => {
    expect(
      resolveActiveGitHubToken({
        typedToken: "",
        hasSavedToken: true,
      }),
    ).toEqual({
      source: "saved",
      fingerprint: SAVED_GITHUB_TOKEN_FINGERPRINT,
    });

    expect(
      resolveActiveGitHubToken({
        typedToken: "   ",
        hasSavedToken: true,
      })?.source,
    ).toBe("saved");
  });

  it("rejects repo verification tied to a previous GitHub token fingerprint", () => {
    const url = "https://github.com/acme/my-product";
    const oldFingerprint = valueFingerprint("old-token");
    const newFingerprint = valueFingerprint("new-token");
    const verification = {
      state: "connected" as const,
      verifiedTargetRepo: url,
      verifiedGithubTokenFingerprint: oldFingerprint,
      message: "Connected to acme/my-product",
    };

    expect(isRepoVerifiedForUrl(verification, url)).toBe(true);
    expect(isRepoVerifiedForActiveToken(verification, url, newFingerprint)).toBe(
      false,
    );
    expect(isRepoVerifiedForActiveToken(verification, url, oldFingerprint)).toBe(
      true,
    );
  });

  it("rejects failed repo verification tied to a previous GitHub token fingerprint", () => {
    const url = "https://github.com/acme/my-product";
    const verification = {
      state: "failed" as const,
      attemptedTargetRepo: url,
      attemptedGithubTokenFingerprint: valueFingerprint("old-token"),
      message: "Missing workflow access",
    };

    expect(
      isRepoFailedForActiveToken(
        verification,
        url,
        valueFingerprint("new-token"),
      ),
    ).toBe(false);
    expect(
      isRepoFailedForActiveToken(
        verification,
        url,
        valueFingerprint("old-token"),
      ),
    ).toBe(true);
  });

  it("creates unique guided repo row ids", () => {
    const id1 = createGuidedRepoRowId(1);
    const id2 = createGuidedRepoRowId(2);
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });
});
