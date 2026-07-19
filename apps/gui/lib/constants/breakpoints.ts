export const BREAKPOINTS = {
  tablet: "md",
  desktop: "lg",
} as const;

export const RESPONSIVE = {
  pageTitle: "text-2xl font-semibold tracking-tight md:text-3xl",
  pageDescription: "text-sm text-muted-foreground md:text-base",
  sectionTitle: "text-lg font-semibold tracking-tight md:text-xl",
  sectionDescription: "text-sm text-muted-foreground",
  twoColumnGrid: "grid grid-cols-1 gap-4 md:grid-cols-2",
  previewPanel: "overflow-x-auto rounded-md border border-border bg-muted/40 p-4 text-xs md:text-sm",
} as const;
