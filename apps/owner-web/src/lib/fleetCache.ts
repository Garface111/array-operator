/**
 * Instant paint for Fleet: stash last successful snapshot in localStorage
 * (same idea as desktop fleet-store stale-while-revalidate).
 */
import type { FleetTree, Overview } from "./types";

const KEY = "ao_owner_web_fleet_cache_v1";
const MAX_AGE_MS = 1000 * 60 * 60 * 6; // 6h

export type FleetCache = {
  at: number;
  overview?: Overview | null;
  tree?: FleetTree | null;
};

export function readFleetCache(): FleetCache | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as FleetCache;
    if (!c?.at || Date.now() - c.at > MAX_AGE_MS) return null;
    return c;
  } catch {
    return null;
  }
}

export function writeFleetCache( partial: {
  overview?: Overview | null;
  tree?: FleetTree | null;
}): void {
  try {
    const prev = readFleetCache() || { at: 0 };
    const next: FleetCache = {
      at: Date.now(),
      overview:
        partial.overview !== undefined ? partial.overview : prev.overview,
      tree: partial.tree !== undefined ? partial.tree : prev.tree,
    };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
}
