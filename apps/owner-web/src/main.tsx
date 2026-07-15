import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/index.css";
import { APP_BASE } from "./lib/base";

// Token exchange happens in AuthGate (async) — do not set raw ?token= as session.
// basename matches Vite `base` (/m/ in prod beta).
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={APP_BASE || undefined}>
      <App />
    </BrowserRouter>
  </StrictMode>
);
