export const FORM = {
  fieldStack: "space-y-2",
  fieldGrid: "grid grid-cols-1 gap-4 md:grid-cols-2",
  actions: "flex flex-wrap items-center gap-3",
  confirmationBox:
    "rounded-md border border-border bg-muted/20 p-4 space-y-3",
  secretHint: "text-xs text-muted-foreground",
  /**
   * Native select styling matched to shared Input (`h-9`) for guided Configure steps.
   */
  guidedSelect:
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
} as const;
