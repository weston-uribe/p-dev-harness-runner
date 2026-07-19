import { writeFile } from "node:fs/promises";
import { zodToJsonSchema } from "zod-to-json-schema";
import { harnessConfigSchema } from "../src/config/schema.js";

const schema = zodToJsonSchema(harnessConfigSchema, {
  name: "HarnessConfig",
  $refStrategy: "none",
});

await writeFile(
  "harness.config.schema.json",
  `${JSON.stringify(schema, null, 2)}\n`,
  "utf8",
);

console.log("Wrote harness.config.schema.json");
