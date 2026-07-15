import { Navigate, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/auth/AuthGate";
import { AppShell } from "@/components/AppShell";
import { ConnectScreen } from "@/screens/ConnectScreen";
import { FleetScreen } from "@/screens/FleetScreen";
import { HomeScreen } from "@/screens/HomeScreen";
import { InvoicesScreen } from "@/screens/InvoicesScreen";
import { LoginScreen } from "@/screens/LoginScreen";
import { MoreScreen } from "@/screens/MoreScreen";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route element={<AuthGate />}>
        <Route element={<AppShell />}>
          <Route index element={<HomeScreen />} />
          <Route path="fleet" element={<FleetScreen />} />
          <Route path="invoices" element={<InvoicesScreen />} />
          <Route path="connect" element={<ConnectScreen />} />
          <Route path="more" element={<MoreScreen />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
