import { useEffect, useMemo, useState } from "react";
import { siteUrl } from "@/lib/base";
import { isDemoMode } from "@/lib/demoData";

type StateBrief = {
  name?: string;
  comp?: string;
  how?: string;
  note?: string;
  utils?: string[];
  reg?: string;
  sources?: Array<{ l?: string; u?: string }>;
};

type ResourcesData = {
  updated?: string;
  note?: string;
  states?: Record<string, StateBrief>;
  rec?: {
    title?: string;
    body?: string;
    sources?: Array<{ l?: string; u?: string }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type NewsItem = {
  title?: string;
  url?: string;
  state?: string;
  date?: string;
  summary?: string;
  source?: string;
  [key: string]: unknown;
};

const ORDER = ["vt", "nh", "me", "ma", "ct", "ri"];

export function ResourcesScreen() {
  const [data, setData] = useState<ResourcesData | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [state, setState] = useState("vt");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("ao_res_state");
      if (saved && ORDER.includes(saved)) setState(saved);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const [rd, nw] = await Promise.all([
          fetch(siteUrl("/resources-data.json"))
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
          fetch(siteUrl("/news.json"))
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ]);
        if (cancelled) return;
        setData(rd);
        const items = Array.isArray(nw)
          ? nw
          : Array.isArray(nw?.items)
            ? nw.items
            : Array.isArray(nw?.news)
              ? nw.news
              : [];
        setNews(items as NewsItem[]);
        if (!rd) setErr("Could not load briefing data.");
      } catch (e) {
        if (!cancelled)
          setErr(e instanceof Error ? e.message : "Load failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function pickState(code: string) {
    setState(code);
    try {
      localStorage.setItem("ao_res_state", code);
    } catch {
      /* ignore */
    }
  }

  const brief = data?.states?.[state];
  const stateName = brief?.name || state.toUpperCase();

  const filteredNews = useMemo(() => {
    return news
      .filter((n) => {
        const s = String(n.state || "region").toLowerCase();
        return (
          s === state ||
          s === "region" ||
          s === "rec" ||
          s === "ne" ||
          s === "new_england"
        );
      })
      .slice(0, 12);
  }, [news, state]);

  return (
    <div className="space-y-4">
      {isDemoMode() ? (
        <div className="rounded-2xl border border-amber-200/60 bg-amber-50/55 px-3.5 py-2 text-xs font-semibold text-amber-950 backdrop-blur-md">
          Resources load live from the site — same briefing as desktop.
        </div>
      ) : null}

      <div>
        <h1 className="text-lg font-extrabold">Resources</h1>
        <p className="text-sm text-slate-800/75">
          Net-metering rates, REC market, and regional news.
        </p>
      </div>

      {loading ? (
        <p className="text-sm font-semibold text-muted">Loading briefing…</p>
      ) : null}
      {err ? (
        <p className="text-xs font-semibold text-red-700">{err}</p>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {ORDER.map((code) => {
          const label = data?.states?.[code]?.name || code.toUpperCase();
          const short = label.split(" ")[0];
          return (
            <button
              key={code}
              type="button"
              onClick={() => pickState(code)}
              className={[
                "rounded-full px-2.5 py-1 text-[11px] font-extrabold",
                state === code
                  ? "bg-sky-500 text-white shadow"
                  : "bg-white/45 text-slate-800 ring-1 ring-white/60",
              ].join(" ")}
            >
              {short}
            </button>
          );
        })}
      </div>

      {brief ? (
        <section className="ao-card space-y-3 p-3.5">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-sm font-extrabold">{stateName}</h2>
            {data?.updated ? (
              <span className="text-[10px] font-bold text-muted">
                Updated {data.updated}
              </span>
            ) : null}
          </div>
          {brief.comp ? (
            <p className="text-xs leading-relaxed font-medium text-slate-800">
              {brief.comp}
            </p>
          ) : null}
          {brief.how ? (
            <div>
              <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-800">
                How it works
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                {brief.how}
              </p>
            </div>
          ) : null}
          {brief.note ? (
            <p className="rounded-xl bg-amber-50/70 px-2.5 py-2 text-[11px] font-semibold text-amber-950">
              {brief.note}
            </p>
          ) : null}
          {brief.utils?.length ? (
            <div>
              <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-800">
                Utilities
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {brief.utils.join(" · ")}
              </p>
            </div>
          ) : null}
          {brief.reg ? (
            <div>
              <div className="text-[10px] font-extrabold uppercase tracking-wider text-sky-800">
                Regulatory
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                {brief.reg}
              </p>
            </div>
          ) : null}
          {brief.sources?.length ? (
            <ul className="space-y-1 border-t border-white/40 pt-2">
              {brief.sources.map((s, i) => (
                <li key={i}>
                  <a
                    href={s.u || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-bold text-sky-800"
                  >
                    {s.l || s.u} ↗
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : !loading ? (
        <div className="ao-card p-4 text-sm text-muted">
          No briefing for this state yet.
        </div>
      ) : null}

      {data?.rec && (data.rec.title || data.rec.body) ? (
        <section className="ao-card space-y-2 p-3.5">
          <h2 className="text-sm font-extrabold">
            {String(data.rec.title || "REC market")}
          </h2>
          {data.rec.body ? (
            <p className="text-xs leading-relaxed text-muted">
              {String(data.rec.body)}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-extrabold">News · {stateName}</h2>
        {filteredNews.length === 0 ? (
          <div className="ao-card p-4 text-sm text-muted">
            No recent headlines for this filter.
          </div>
        ) : (
          <ul className="space-y-2">
            {filteredNews.map((n, i) => (
              <li key={i} className="ao-card p-3.5">
                <a
                  href={n.url || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-extrabold text-sky-950"
                >
                  {n.title || "Update"}
                </a>
                <div className="mt-1 text-[10px] font-bold uppercase text-muted">
                  {[n.state, n.date, n.source].filter(Boolean).join(" · ")}
                </div>
                {n.summary ? (
                  <p className="mt-1.5 text-xs leading-relaxed text-muted">
                    {n.summary}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {data?.note ? (
        <p className="text-[11px] leading-relaxed text-muted">{data.note}</p>
      ) : null}
    </div>
  );
}
