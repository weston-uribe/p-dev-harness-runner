import type { WorkflowScope } from "@harness/workflow-page/types";
import { Label } from "@/components/ui/label";

type WorkflowScopeSelectorProps = {
  scopes: WorkflowScope[];
  selectedScopeId?: string;
  disabled?: boolean;
  onScopeChange: (scopeId: string) => void;
};

export function WorkflowScopeSelector({
  scopes,
  selectedScopeId,
  disabled = false,
  onScopeChange,
}: WorkflowScopeSelectorProps) {
  if (scopes.length <= 1) {
    return null;
  }

  return (
    <div className="space-y-1">
      <Label htmlFor="workflow-scope-select" className="text-xs text-muted-foreground">
        Workflow scope
      </Label>
      <select
        id="workflow-scope-select"
        className="max-w-md rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        value={selectedScopeId ?? scopes[0]?.id ?? ""}
        disabled={disabled}
        onChange={(event) => onScopeChange(event.target.value)}
      >
        {scopes.map((scope) => (
          <option key={scope.id} value={scope.id}>
            {scope.targetRepo}
          </option>
        ))}
      </select>
    </div>
  );
}
