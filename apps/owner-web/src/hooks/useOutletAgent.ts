import { useOutletContext } from "react-router-dom";
import type { ShellOutlet } from "@/components/AppShell";

export function useOutletAgent() {
  return useOutletContext<ShellOutlet>();
}
