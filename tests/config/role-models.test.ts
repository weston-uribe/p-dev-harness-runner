import { describe, expect, it } from "vitest";
import {
  roleModelsSchema,
  roleModelSelectionSchema,
} from "../../src/config/role-models.js";

describe("roleModelsSchema", () => {
  it("accepts durable planner and builder selections", () => {
    const parsed = roleModelsSchema.parse({
      planner: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
      builder: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
    });
    expect(parsed.planner?.id).toBe("composer-2.5");
    expect(parsed.builder?.id).toBe("composer-2.5");
  });

  it("rejects duplicate parameter ids within a role", () => {
    const result = roleModelSelectionSchema.safeParse({
      id: "composer-2.5",
      params: [
        { id: "fast", value: "false" },
        { id: "fast", value: "true" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level role keys", () => {
    const result = roleModelsSchema.safeParse({
      planner: { id: "composer-2.5" },
      reviewer: { id: "composer-2.5" },
    });
    expect(result.success).toBe(false);
  });
});
