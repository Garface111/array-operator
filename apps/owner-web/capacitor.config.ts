import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Array Operator — store shells (Android + iOS).
 *
 * Web assets: `dist/` built with:
 *   VITE_BASE=./ VITE_API_BASE=https://arrayoperator.com VITE_SITE_ORIGIN=https://arrayoperator.com
 *
 * Same backend + so_session as arrayoperator.com/m — one account, all data.
 */
const config: CapacitorConfig = {
  appId: "com.arrayoperator.app",
  appName: "Array Operator",
  webDir: "dist",
  bundledWebRuntime: false,
  server: {
    // Bundled assets; API calls go to VITE_API_BASE (absolute HTTPS).
    androidScheme: "https",
    iosScheme: "https",
    // Allow navigation to API / Stripe / OAuth
    allowNavigation: [
      "arrayoperator.com",
      "*.arrayoperator.com",
      "nepooloperator.com",
      "*.nepooloperator.com",
      "solaroperator.org",
      "*.stripe.com",
      "checkout.stripe.com",
      "connect.stripe.com",
    ],
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: "#f0f9ff",
      showSpinner: false,
      androidScaleType: "CENTER_CROP",
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: "LIGHT",
      backgroundColor: "#f0f9ff",
    },
    Keyboard: {
      resize: "body",
      resizeOnFullScreen: true,
    },
  },
  android: {
    allowMixedContent: false,
    backgroundColor: "#f0f9ff",
  },
  ios: {
    backgroundColor: "#f0f9ff",
    contentInset: "automatic",
    preferredContentMode: "mobile",
    scheme: "Array Operator",
  },
};

export default config;
