export const LAYOUT = {
  page: "mx-auto w-full max-w-5xl",
  shell: "min-h-screen bg-background",
  header: "sticky top-0 z-50 border-b border-border bg-background",
  /** Wide shell: brand + settings aligned near outer application gutters. */
  headerInner:
    "mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6",
  main: "mx-auto w-full max-w-7xl px-4 py-8 md:px-6 md:py-10",
  /** Centered Configure column for disclosure, progress, and guided step cards. */
  configureContent: "mx-auto w-full max-w-3xl",
  sectionStack: "flex flex-col gap-6",
  cardGrid: "grid grid-cols-1 gap-4 md:grid-cols-2",
} as const;

export const APP_HEADER_STICKY_CLASS = "sticky top-0 z-50";
export const APP_MAIN_CLASS = LAYOUT.main;
