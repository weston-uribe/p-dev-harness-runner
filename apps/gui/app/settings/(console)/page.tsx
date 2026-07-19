import { redirect } from "next/navigation";

import { SETTINGS_DEFAULT_ROUTE } from "@/lib/settings/settings-navigation";

export default function SettingsIndexPage() {
  redirect(SETTINGS_DEFAULT_ROUTE);
}
