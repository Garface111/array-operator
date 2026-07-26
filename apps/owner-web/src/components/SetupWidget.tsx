import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";

/**
 * The interactive setup card the agent opens INSIDE the chat.
 *
 * Before this, the four "Set up with Agent" CTAs sent a prompt, the agent called
 * portal_links, and the only action it owned was open_url — so every setup ended
 * in "go to the website". The endpoints all existed; nothing let the agent drive
 * them. `open_setup_widget` picks a pillar, this renders the real form, and it
 * posts straight to the live endpoint.
 *
 * The password is typed here, in a native field, and goes directly to the vault
 * endpoint. It never enters the chat transcript and is never seen by the model —
 * which is why the agent is told (in the tool description) never to ask for one.
 */
export type SetupWidgetSpec = {
  type: "setup_widget";
  pillar: "arrays" | "auto_refresh" | "utility_bills";
  title: string;
  blurb: string;
  endpoint?: string;
  vendors?: string[];
  providers_url?: string;
  needs_consent?: boolean;
  needs_login_host?: boolean;
  provider?: string;
};

type Provider = {
  code: string;
  label: string;
  state?: string;
  smarthub_host?: string;
  scrape_status?: string;
};

const VENDOR_LABEL: Record<string, string> = {
  solaredge: "SolarEdge",
  locus: "Locus",
  fronius: "Fronius (Solar.web)",
  alsoenergy: "AlsoEnergy",
  sma: "SMA (Sunny Portal)",
  chint: "Chint",
  gmp: "Green Mountain Power",
};

const label = (c: string) => VENDOR_LABEL[c] || c;

export function SetupWidget({
  spec,
  onResult,
}: {
  spec: SetupWidgetSpec;
  onResult: (line: string) => void;
}) {
  const [vendor, setVendor] = useState(spec.provider || spec.vendors?.[0] || "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loginHost, setLoginHost] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Utility pillar: the real provider registry, not a hardcoded list.
  const [providers, setProviders] = useState<Provider[]>([]);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!spec.providers_url) return;
    apiFetch<{ providers?: Provider[] }>(spec.providers_url)
      .then((r) => setProviders(r.providers || []))
      .catch(() => setProviders([]));
  }, [spec.providers_url]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return providers
      .filter(
        (p) =>
          p.label?.toLowerCase().includes(q) || p.code?.toLowerCase().includes(q)
      )
      .slice(0, 6);
  }, [query, providers]);

  // SolarEdge connects with an account API key; everything else is a login.
  const isApiKeyVendor = spec.pillar === "arrays" && vendor === "solaredge";
  const needsHost =
    !!spec.needs_login_host &&
    !!providers.find((p) => p.code === vendor)?.smarthub_host === false;

  const canSubmit =
    !busy &&
    (isApiKeyVendor
      ? apiKey.trim().length > 8
      : !!vendor && username.trim() !== "" && password !== "") &&
    (!spec.needs_consent || consent);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      let msg: string;
      if (isApiKeyVendor) {
        const r = await apiFetch<{ connected?: number; arrays?: unknown[] }>(
          "/v1/array-owners/solaredge/connect-account",
          { method: "POST", body: JSON.stringify({ api_key: apiKey.trim() }) }
        );
        const n = r.connected ?? r.arrays?.length ?? 0;
        msg = `Connected SolarEdge — ${n} site${n === 1 ? "" : "s"} attached.`;
      } else if (spec.pillar === "arrays" && vendor === "locus") {
        const r = await apiFetch<{ connected?: number; arrays?: unknown[] }>(
          "/v1/array-owners/locus/connect-account",
          {
            method: "POST",
            body: JSON.stringify({ username: username.trim(), password }),
          }
        );
        const n = r.connected ?? r.arrays?.length ?? 0;
        msg = `Connected Locus — ${n} site${n === 1 ? "" : "s"} attached.`;
      } else {
        // Portal capture / utility: the vault endpoint. consent is REQUIRED
        // server-side before a password is stored.
        await apiFetch("/v1/cloud-capture/credentials", {
          method: "POST",
          body: JSON.stringify({
            provider: vendor,
            username: username.trim(),
            password,
            login_host: loginHost.trim() || undefined,
            enable: true,
            consent: true,
          }),
        });
        msg =
          spec.pillar === "utility_bills"
            ? `Saved the ${label(vendor)} utility login — bills will start flowing into invoices.`
            : `Saved the ${label(vendor)} login — auto-refresh is on, no browser tab needed.`;
      }
      setPassword("");
      setApiKey("");
      setDone(msg);
      onResult(msg);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="ao-card mt-2 max-w-[92%] p-3">
        <div className="text-xs font-extrabold text-emerald-700">✓ {done}</div>
      </div>
    );
  }

  return (
    <div className="ao-card mt-2 max-w-[92%] space-y-2.5 p-3">
      <div>
        <div className="text-sm font-extrabold">{spec.title}</div>
        <p className="mt-0.5 text-[11px] font-semibold text-muted">{spec.blurb}</p>
      </div>

      {/* Utility: search the real registry. Vendors: a short fixed list. */}
      {spec.providers_url ? (
        <div>
          <input
            className="w-full rounded-xl border border-sky-100 px-3 py-2 text-sm font-semibold"
            placeholder="Search your utility…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVendor("");
            }}
            autoComplete="off"
          />
          {vendor ? (
            <div className="mt-1 text-[11px] font-bold text-sky-700">
              Selected: {label(vendor)}
            </div>
          ) : null}
          {matches.length ? (
            <ul className="mt-1 space-y-1">
              {matches.map((p) => (
                <li key={p.code}>
                  <button
                    type="button"
                    className="w-full rounded-lg bg-sky-50 px-2.5 py-1.5 text-left text-[11px] font-bold text-sky-900"
                    onClick={() => {
                      setVendor(p.code);
                      setQuery(p.label);
                      if (p.smarthub_host) setLoginHost(p.smarthub_host);
                    }}
                  >
                    {p.label}
                    {p.state ? ` · ${p.state}` : ""}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <select
          className="w-full rounded-xl border border-sky-100 px-3 py-2 text-sm font-semibold"
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
        >
          {(spec.vendors || []).map((v) => (
            <option key={v} value={v}>
              {label(v)}
            </option>
          ))}
        </select>
      )}

      {isApiKeyVendor ? (
        <input
          className="w-full rounded-xl border border-sky-100 px-3 py-2 text-sm font-semibold"
          placeholder="SolarEdge account API key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      ) : (
        <>
          <input
            className="w-full rounded-xl border border-sky-100 px-3 py-2 text-sm font-semibold"
            placeholder="Portal username or email"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            spellCheck={false}
          />
          <input
            className="w-full rounded-xl border border-sky-100 px-3 py-2 text-sm font-semibold"
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {needsHost ? (
            <input
              className="w-full rounded-xl border border-sky-100 px-3 py-2 text-sm font-semibold"
              placeholder="Portal host (e.g. yourcoop.smarthub.coop)"
              value={loginHost}
              onChange={(e) => setLoginHost(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          ) : null}
        </>
      )}

      {spec.needs_consent && !isApiKeyVendor ? (
        <label className="flex items-start gap-2 text-[11px] font-semibold text-muted">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span>
            Store this login encrypted so Array Operator can sign in for you and
            keep data fresh. You can remove it any time.
          </span>
        </label>
      ) : null}

      {err ? (
        <p className="text-[11px] font-bold text-red-600">{err}</p>
      ) : null}

      <button
        type="button"
        className="ao-btn-primary w-full disabled:opacity-50"
        disabled={!canSubmit}
        onClick={submit}
      >
        {busy ? "Saving…" : "Save and connect"}
      </button>
      <p className="text-[10px] font-semibold text-muted">
        Typed here and sent straight to the encrypted vault — it never goes
        through the chat.
      </p>
    </div>
  );
}
