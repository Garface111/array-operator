import { useOutletAgent } from "@/hooks/useOutletAgent";

const FEEDS = [
  {
    id: "arrays",
    title: "Arrays / inverters",
    blurb: "Live production feed — SolarEdge, Locus, portal capture…",
    prompt:
      "Help me get arrays talking. Prefer one-click portal login. What's missing on my account?",
  },
  {
    id: "autorefresh",
    title: "Auto-refresh",
    blurb: "Cloud capture 24/7 so data stays fresh without a browser tab.",
    prompt:
      "I want cloud auto-refresh. Walk me through saving a monitoring login for 24/7 capture.",
  },
  {
    id: "utility",
    title: "Utility bills",
    blurb: "Source of truth for offtaker invoices (GMP / SmartHub).",
    prompt:
      "Help me link utility bills (GMP or co-op) so invoices have a real bill source.",
  },
  {
    id: "pay",
    title: "Online pay",
    blurb: "Stripe Connect so offtakers can pay from the email.",
    prompt:
      "Do I need online pay? If yes, walk me through Stripe Connect for offtakers.",
  },
] as const;

export function ConnectScreen() {
  const { openAgent } = useOutletAgent();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-extrabold">Connect</h1>
        <p className="text-sm text-muted">
          Hands-off feeds. Agent walks the steps; desktop site stays for deep
          forms until we port them.
        </p>
      </div>
      <ul className="space-y-2.5">
        {FEEDS.map((f) => (
          <li key={f.id} className="ao-card p-3.5">
            <div className="font-extrabold">{f.title}</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">{f.blurb}</p>
            <button
              type="button"
              className="mt-3 text-xs font-bold text-sky-700"
              onClick={() => openAgent(f.prompt)}
            >
              Set up with Agent →
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
