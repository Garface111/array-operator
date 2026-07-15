import { Navigate, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/auth/AuthGate";
import { AppShell } from "@/components/AppShell";
import { AccountScreen } from "@/screens/AccountScreen";
import { AnalysisScreen } from "@/screens/AnalysisScreen";
import { ConnectScreen } from "@/screens/ConnectScreen";
import { FleetScreen } from "@/screens/FleetScreen";
import { HomeScreen } from "@/screens/HomeScreen";
import { InvoicesScreen } from "@/screens/InvoicesScreen";
import { LoginScreen } from "@/screens/LoginScreen";
import { ResourcesScreen } from "@/screens/ResourcesScreen";

/**
 * Routes mirror desktop tab hashes:
 *   #dashboard → /triage
 *   #arrays    → /inverters  (default)
 *   #analysis  → /analysis
 *   #reports   → /invoices
 *   #resources → /resources
 *   #account   → /account
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route element={<AuthGate />}>
        <Route element={<AppShell />}>
          {/* Desktop default is Inverters (#arrays) */}
          <Route index element={<Navigate to="/inverters" replace />} />
          <Route path="triage" element={<HomeScreen />} />
          <Route path="dashboard" element={<Navigate to="/triage" replace />} />
          <Route path="inverters" element={<FleetScreen />} />
          <Route path="fleet" element={<Navigate to="/inverters" replace />} />
          <Route path="arrays" element={<Navigate to="/inverters" replace />} />
          <Route path="analysis" element={<AnalysisScreen />} />
          <Route path="trends" element={<Navigate to="/analysis?view=trends" replace />} />
          <Route path="invoices" element={<InvoicesScreen />} />
          <Route path="reports" element={<Navigate to="/invoices" replace />} />
          <Route path="resources" element={<ResourcesScreen />} />
          <Route path="account" element={<AccountScreen />} />
          <Route path="connect" element={<ConnectScreen />} />
          <Route path="more" element={<Navigate to="/account" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/inverters" replace />} />
    </Routes>
  );
}
