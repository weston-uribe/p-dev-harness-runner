import { z } from "zod";

export const ROLE_MODEL_ROLES = [
  "planner",
  "builder",
  "planReviewer",
  "codeReviewer",
  "codeReviser",
] as const;
export type RoleModelRole = (typeof ROLE_MODEL_ROLES)[number];

export const modelParameterValueSchema = z.object({
  id: z.string().min(1),
  value: z.string(),
});

export const roleModelSelectionSchema = z
  .object({
    id: z.string().min(1),
    params: z.array(modelParameterValueSchema).optional(),
  })
  .superRefine((selection, ctx) => {
    const paramIds = selection.params?.map((param) => param.id) ?? [];
    const unique = new Set(paramIds);
    if (unique.size !== paramIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate parameter ids are not allowed within a role model selection",
      });
    }
  });

export const roleModelsSchema = z
  .object({
    planner: roleModelSelectionSchema.optional(),
    builder: roleModelSelectionSchema.optional(),
    planReviewer: roleModelSelectionSchema.optional(),
    codeReviewer: roleModelSelectionSchema.optional(),
    codeReviser: roleModelSelectionSchema.optional(),
  })
  .strict();

export type RoleModelSelection = z.infer<typeof roleModelSelectionSchema>;
export type RoleModelsConfig = z.infer<typeof roleModelsSchema>;

export function isRoleModelRole(value: string): value is RoleModelRole {
  return (ROLE_MODEL_ROLES as readonly string[]).includes(value);
}
