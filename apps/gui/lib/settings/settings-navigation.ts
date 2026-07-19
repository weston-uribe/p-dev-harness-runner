export const SETTINGS_NAV_ITEMS = [
  { href: "/settings/connections", label: "Connections" },
  { href: "/settings/linear", label: "Linear" },
  { href: "/settings/repositories", label: "Target repositories" },
  { href: "/settings/deployments", label: "Deployments" },
  { href: "/settings/models", label: "Models" },
  { href: "/settings/prompts", label: "Prompts and skills" },
  { href: "/settings/data-sharing", label: "Data and privacy" },
] as const;

export const SETTINGS_DEFAULT_ROUTE = SETTINGS_NAV_ITEMS[0].href;
