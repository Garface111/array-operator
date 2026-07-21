import { describe, expect, it } from "vitest";
import { adaptFleetTree, adaptOverviewArrays } from "./api";
import type { FleetTreeRaw, Overview } from "./types";

describe("adaptFleetTree", () => {
  it("maps live columns[] shape (not arrays[]) into UI arrays", () => {
    const raw: FleetTreeRaw = {
      columns: [
        {
          array_id: 1284,
          array_name: "Waterford",
          vendor: "fronius",
          produced_today_kwh: 12.5,
          alert: { status: "ok", level: "ok" },
          inverters: [
            {
              inverter_id: 9,
              name: "Primo 1",
              status: "ok",
              peer_index: 1.01,
            },
            {
              inverter_id: 10,
              name: "Primo 2",
              status: "underperforming",
              peer_index: 0.6,
            },
          ],
        },
      ],
      summary: { arrays_total: 1, inverters_total: 2, attention: 1 },
    };
    const tree = adaptFleetTree(raw);
    expect(tree.arrays).toHaveLength(1);
    expect(tree.arrays[0].id).toBe(1284);
    expect(tree.arrays[0].name).toBe("Waterford");
    expect(tree.arrays[0].inverters).toHaveLength(2);
    expect(tree.arrays[0].inverters?.[1].status).toBe("underperforming");
    // Quiet alert + underperforming inverter → rolled-up status
    expect(tree.arrays[0].status).toBe("underperforming");
  });

  it("returns empty when neither columns nor arrays present", () => {
    expect(adaptFleetTree({}).arrays).toEqual([]);
    expect(adaptFleetTree(null).arrays).toEqual([]);
  });
});

describe("adaptOverviewArrays", () => {
  it("maps array_id / health.status / peer fields", () => {
    const ov: Overview = {
      arrays: [
        {
          array_id: 1028,
          name: "Catamount Ridge Solar",
          health: { status: "stale", message: "No data for 50 days" },
          peer: { status: "ok", peer_index: null, diagnosis: "Reporting" },
          today: { kwh: 0 },
        },
      ],
    };
    const list = adaptOverviewArrays(ov);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(1028);
    expect(list[0].name).toBe("Catamount Ridge Solar");
    expect(list[0].status).toBe("stale");
    expect(list[0].today_kwh).toBe(0);
  });
});
