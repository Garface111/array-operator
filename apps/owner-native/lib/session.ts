import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const KEY = "so_session";

/** SecureStore on native; localStorage-backed polyfill path via SecureStore web when available. */
export async function getSession(): Promise<string | null> {
  try {
    if (Platform.OS === "web") {
      // expo-secure-store falls back; also check localStorage for web dogfood
      try {
        const ls = globalThis?.localStorage?.getItem?.(KEY);
        if (ls) return ls;
      } catch {
        /* ignore */
      }
    }
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

export async function setSession(token: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      try {
        globalThis?.localStorage?.setItem?.(KEY, token);
      } catch {
        /* ignore */
      }
    }
    await SecureStore.setItemAsync(KEY, token);
  } catch {
    /* ignore */
  }
}

export async function clearSession(): Promise<void> {
  try {
    if (Platform.OS === "web") {
      try {
        globalThis?.localStorage?.removeItem?.(KEY);
      } catch {
        /* ignore */
      }
    }
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    /* ignore */
  }
}
