import { Navigate, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/auth/AuthGate";
import { AppShell } from "@/components/AppShell";
import { AccountScreen } from "@/screens/AccountScreen";
import { ConnectScreen } from "@/screens/ConnectScreen";
import { HomeScreen } from "@/screens/HomeScreen";
import { InvoicesScreen } from "@/screens/InvoicesScreen";
import { LoginScreen } from "@/screens/LoginScreen";
import { ResourcesScreen } from "@/screens/ResourcesScreen";

/**
 * Mobile four-tab app:
 *   Triage · Invoices · Resources · Account
 * Inverters / Analysis routes redirect into Triage (fleet health lives there).
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route element={<AuthGate />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/triage" replace />} />
          <Route path="triage" element={<HomeScreen />} />
          <Route path="dashboard" element={<Navigate to="/triage" replace />} />
          {/* Retired primary tabs → triage */}
          <Route path="inverters" element={<Navigate to="/triage" replace />} />
          <Route path="fleet" element={<Navigate to="/triage" replace />} />
          <Route path="arrays" element={<Navigate to="/triage" replace />} />
          <Route path="analysis" element={<Navigate to="/triage" replace />} />
          <Route path="trends" element={<Navigate to="/triage" replace />} />
          <Route path="invoices" element={<InvoicesScreen />} />
          <Route path="reports" element={<Navigate to="/invoices" replace />} />
          <Route path="resources" element={<ResourcesScreen />} />
          <Route path="account" element={<AccountScreen />} />
          <Route path="connect" element={<ConnectScreen />} />
          <Route path="more" element={<Navigate to="/account" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/triage" replace />} />
    </Routes>
  );
}
