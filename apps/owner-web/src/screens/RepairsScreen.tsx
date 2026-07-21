import { useEffect, useMemo, useState } from "react";
import { useOutletAgent } from "@/hooks/useOutletAgent";
import { fetchFleetTree } from "@/lib/api";
import { chipClass, statusTone } from "@/lib/format";
import type { FleetArray } from "@/lib/types";

export function RepairsScreen() {
  const { openAgent } = useOutletAgent();
  const [arrays, setArrays] = useState<FleetArray[]>([]);

  useEffect(() => {
    fetchFleetTree()
      .then((t) => setArrays(t.arrays || []))
      .catch(() => setArrays([]));
  }, []);

  const issues = useMemo(() => {
    const rows: { name: string; status: string; kind: string }[] = [];
    arrays.forEach((a) => {
      const t = statusTone(a.status);
      if (t === "warn" || t === "bad")
        rows.push({ name: a.name, status: a.status, kind: "array" });
      (a.inverters || []).forEach((inv) => {
        const it = statusTone(inv.status);
        if (it === "warn" || it === "bad")
          rows.push({
            name: `${a.name} · ${inv.name}`,
            status: inv.status,
            kind: "inverter",
          });
      });
    });
    return rows;
  }, [arrays]);

  return (
    <div className="space-y-3.5">
      <div>
        <h1 className="text-xl font-extrabold tracking-tight">Repairs</h1>
        <p className="text-sm font-medium text-muted">
          Detect · draft outreach · verify
        </p>
      </div>

      <div className="ao-sheet p-4">
        <div className="text-3xl font-extrabold text-ink">{issues.length}</div>
        <div className="text-sm font-semibold text-muted">
          Open attention items from live fleet health
        </div>
        <button
          type="button"
          className="ao-btn-primary mt-3 !min-h-10 !text-xs"
          onClick={() =>
            openAgent(
              "Act as repairs command center: list faults/underperformers, draft owner outreach, and next verification steps."
            )
          }
        >
          Run repairs brief with Agent
        </button>
      </div>

      <ul className="space-y-2">
        {issues.length === 0 ? (
          <li className="ao-card p-4 text-sm text-muted">
            Nothing flagged — fleet health looks clear.
          </li>
        ) : (
          issues.map((row) => (
            <li key={row.name}>
              <button
                type="button"
                className="ao-card flex w-full items-center justify-between gap-2 p-3.5 text-left"
                onClick={() =>
                  openAgent(
                    `Repair focus: ${row.name} (${row.status}). Diagnose and draft next step.`
                  )
                }
              >
                <div>
                  <div className="text-sm font-extrabold">{row.name}</div>
                  <div className="text-[11px] font-semibold text-muted">
                    {row.kind}
                  </div>
                </div>
                <span className={chipClass(statusTone(row.status))}>
                  {row.status}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
