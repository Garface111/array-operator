/**
 * Capacitor native shell bootstrap — status bar, splash, deep links.
 * Safe no-ops on plain web.
 */
import { APP_BASE } from "./base";

/** Soft import so web builds don't require Capacitor at runtime. */
async function isNative(): Promise<boolean> {
  try {
    const core = await import("@capacitor/core");
    return core.Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export async function initNativeShell(): Promise<void> {
  if (!(await isNative())) return;

  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: Style.Light });
    await StatusBar.setBackgroundColor({ color: "#f0f9ff" }).catch(
      () => undefined
    );
  } catch {
    /* plugin optional */
  }

  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide({ fadeOutDuration: 280 });
  } catch {
    /* optional */
  }

  try {
    const { App } = await import("@capacitor/app");
    // Deep links: arrayoperator://auth?token=… or https://arrayoperator.com/m/?token=
    App.addListener("appUrlOpen", ({ url }) => {
      handleDeepLink(url);
    });
    const launch = await App.getLaunchUrl();
    if (launch?.url) handleDeepLink(launch.url);
  } catch {
    /* optional */
  }

  try {
    document.documentElement.classList.add("ao-native");
    document.body.classList.add("ao-native");
  } catch {
    /* ignore */
  }
}

function handleDeepLink(raw: string) {
  try {
    const u = new URL(raw);
    const token =
      u.searchParams.get("token") ||
      u.searchParams.get("session") ||
      (u.hostname === "auth"
        ? u.pathname.replace(/^\//, "") || null
        : null);
    if (token) {
      const base = APP_BASE && APP_BASE !== "." ? `${APP_BASE}/` : "/";
      const next = `${base}?token=${encodeURIComponent(token)}`;
      window.location.replace(next);
      return;
    }
    if (u.pathname && u.pathname !== "/") {
      const path = u.pathname.replace(/^\/m/, "") || "/fleet";
      window.history.replaceState(null, "", path + u.search);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  } catch {
    /* ignore bad urls */
  }
}
