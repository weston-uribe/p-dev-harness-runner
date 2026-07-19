import { describe, expect, it } from "vitest";
import {
  deriveRepoConfigIdFromUrl,
  deriveUniqueRepoConfigIds,
  prepareGuidedConfigFormInput,
} from "../../src/setup/guided-config-form.js";
import { validateConfigFormInput } from "../../src/setup/config-local-editor.js";

describe("guided-config-form", () => {
  it("derives repo config id from target repo URL", () => {
    expect(
      deriveRepoConfigIdFromUrl("https://github.com/acme/my-product"),
    ).toBe("my-product");
  });

  it("prepares guided config for multiple repos", () => {
    const prepared = prepareGuidedConfigFormInput({
      repos: [
        { id: "", targetRepo: "https://github.com/acme/my-product" },
        { id: "", targetRepo: "https://github.com/acme/another-app" },
      ],
    });

    expect(prepared.repos).toHaveLength(2);
    expect(prepared.repos[0]?.id).toBe("my-product");
    expect(prepared.repos[1]?.id).toBe("another-app");
  });

  it("handles duplicate repo names with stable suffixes", () => {
    const ids = deriveUniqueRepoConfigIds([
      { id: "", targetRepo: "https://github.com/acme/my-app" },
      { id: "", targetRepo: "https://github.com/other/my-app" },
      { id: "", targetRepo: "https://github.com/third/my-app" },
    ]);

    expect(ids).toEqual(["my-app", "my-app-2", "my-app-3"]);
  });

  it("builds allowedTargetRepos closure for multiple guided repos", () => {
    const { config } = validateConfigFormInput(
      prepareGuidedConfigFormInput({
        repos: [
          { id: "", targetRepo: "https://github.com/acme/my-product" },
          { id: "", targetRepo: "https://github.com/acme/another-app" },
        ],
      }),
    );

    expect(config.allowedTargetRepos).toEqual([
      "https://github.com/acme/my-product",
      "https://github.com/acme/another-app",
    ]);
  });
});
