import { Navigate, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/auth/AuthGate";
import { AppShell } from "@/components/AppShell";
import { AccountScreen } from "@/screens/AccountScreen";
import { AnalysisScreen } from "@/screens/AnalysisScreen";
import { FleetScreen } from "@/screens/FleetScreen";
import { InvoicesScreen } from "@/screens/InvoicesScreen";
import { LoginScreen } from "@/screens/LoginScreen";
import { MarketplaceScreen } from "@/screens/MarketplaceScreen";
import { RepairsScreen } from "@/screens/RepairsScreen";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route element={<AuthGate />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/fleet" replace />} />
          <Route path="fleet" element={<FleetScreen />} />
          <Route path="analysis" element={<AnalysisScreen />} />
          <Route path="invoices" element={<InvoicesScreen />} />
          <Route path="repairs" element={<RepairsScreen />} />
          <Route path="marketplace" element={<MarketplaceScreen />} />
          <Route path="account" element={<AccountScreen />} />
          {/* legacy deep links */}
          <Route path="home" element={<Navigate to="/fleet" replace />} />
          <Route path="connect" element={<Navigate to="/account" replace />} />
          <Route path="more" element={<Navigate to="/account" replace />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/fleet" replace />} />
    </Routes>
  );
}
