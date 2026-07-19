import { describe, expect, it } from "vitest";
import {
  classifyVerificationFailure,
  classifyVerifyHttpFailure,
} from "../../src/setup/credential-health.js";

describe("credential-health local runtime classification", () => {
  it("maps module-loading failures to local_runtime_error", () => {
    expect(
      classifyVerificationFailure({
        status: "failed",
        message: "Cannot find module './8819.js'",
      }),
    ).toBe("local_runtime_error");
  });

  it("maps auth rejections to credential_invalid", () => {
    expect(
      classifyVerificationFailure({
        status: "failed",
        message: "Vercel rejected this token (unauthorized).",
      }),
    ).toBe("credential_invalid");
  });

  it("maps verify API HTML 500 to local_runtime_error", () => {
    expect(
      classifyVerifyHttpFailure({
        status: 500,
        contentType: "text/html; charset=utf-8",
        body: "<!DOCTYPE html>Cannot find module",
      }),
    ).toBe("local_runtime_error");
  });
});
