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
 *   Fleet · Invoices · Resources · Account
 * (+ center Agent on the dock)
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route element={<AuthGate />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/fleet" replace />} />
          <Route path="fleet" element={<HomeScreen />} />
          <Route path="triage" element={<Navigate to="/fleet" replace />} />
          <Route path="dashboard" element={<Navigate to="/fleet" replace />} />
          <Route path="inverters" element={<Navigate to="/fleet" replace />} />
          <Route path="arrays" element={<Navigate to="/fleet" replace />} />
          <Route path="analysis" element={<Navigate to="/fleet" replace />} />
          <Route path="trends" element={<Navigate to="/fleet" replace />} />
          <Route path="invoices" element={<InvoicesScreen />} />
          <Route path="reports" element={<Navigate to="/invoices" replace />} />
          <Route path="resources" element={<ResourcesScreen />} />
          <Route path="account" element={<AccountScreen />} />
          <Route path="connect" element={<ConnectScreen />} />
          <Route path="more" element={<Navigate to="/account" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/fleet" replace />} />
    </Routes>
  );
}
