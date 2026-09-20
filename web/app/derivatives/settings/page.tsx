import { redirect } from "next/navigation";

export default function DerivativesSettingsPage() {
  redirect("/settings?tab=derivatives");
}
