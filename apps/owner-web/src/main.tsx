import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles/index.css";
import { APP_BASE } from "./lib/base";
import { initNativeShell } from "./lib/nativeShell";

// Token exchange happens in AuthGate (async) — do not set raw ?token= as session.
// basename matches Vite `base` (/m/ web beta; empty for native ./ builds).
void initNativeShell();

const basename =
  !APP_BASE || APP_BASE === "." ? undefined : APP_BASE;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </StrictMode>
);
