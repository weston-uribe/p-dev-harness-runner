"use client";

export function WorkflowOptionalEnableControl(props: {
  visible?: boolean;
  enabled?: boolean;
  label?: string;
  disabled?: boolean;
  onChange?: (enabled: boolean) => void;
}) {
  if (!props.visible) return null;
  return (
    <label className="workflow-optional-enable flex items-center gap-2" data-testid="optional-phase-enable">
      <input
        type="checkbox"
        checked={props.enabled ?? false}
        disabled={props.disabled}
        onChange={(event) => props.onChange?.(event.target.checked)}
      />
      {props.label ?? "Enable optional phase"}
    </label>
  );
}

export function WorkflowCycleLimitControl(props: {
  visible?: boolean;
  cycleName?: string;
  limit?: number;
  disabled?: boolean;
  onChange?: (limit: number) => void;
}) {
  if (!props.visible) return null;
  return (
    <label className="workflow-cycle-limit flex flex-col gap-1" data-testid="cycle-limit-control">
      <span className="text-xs text-muted-foreground">
        Max {props.cycleName ?? "review cycles"}
      </span>
      <input
        type="number"
        min={1}
        step={1}
        className="w-24 rounded-md border border-border bg-background px-2 py-1"
        value={props.limit ?? 4}
        disabled={props.disabled}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(parsed) && parsed >= 1) {
            props.onChange?.(parsed);
          }
        }}
      />
    </label>
  );
}

export function WorkflowBypassPathDisplay(props: {
  visible?: boolean;
  bypassLabel?: string;
}) {
  if (!props.visible) return null;
  return (
    <div className="workflow-bypass-path text-muted-foreground" data-testid="bypass-path-display">
      Bypass: {props.bypassLabel ?? "—"}
    </div>
  );
}

export function WorkflowSetupRequirementsList(props: {
  visible?: boolean;
  messages?: readonly string[];
}) {
  if (!props.visible || !props.messages?.length) return null;
  return (
    <div className="workflow-setup-requirements space-y-1" data-testid="setup-requirements">
      <p className="font-medium">Setup required</p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        {props.messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </div>
  );
}

export function WorkflowAgentModelRoleDisplay(props: {
  visible?: boolean;
  agentRole?: string | null;
  modelRole?: string | null;
}) {
  if (!props.visible) return null;
  return (
    <div className="workflow-role-display" data-testid="agent-model-role-display">
      Agent: {props.agentRole ?? "—"} · Model: {props.modelRole ?? "—"}
    </div>
  );
}
