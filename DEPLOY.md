# Array Operator — frontend deploy rules (read before any Netlify command)

**Incident 2026-07-20:** prod (`arrayoperator.com`) served the preprod
**“Private preview”** IP gate to all customers after a mistaken
`netlify deploy --prod --dir public` from the **repo root**. The CLI attached
root `netlify.toml` edge function `gate` to the production site. Fix: redeploy
`public/` only via REST (no edge functions). Do not let this happen again.

## Two sites — two deploy commands — never mix them

| Environment | Site | URL | Command |
|-------------|------|-----|---------|
| **Production** | `array-operator-ea` (`966cb1f5-944e-41fd-855b-10053edc5d18`) | https://arrayoperator.com | **`scripts/deploy-and-verify.sh`** |
| **Preprod (gated)** | `ao-owner-web-preview` (`f6c82d88-8d69-4f88-abac-df195a34fe77`) | ao-owner-web-preview.netlify.app | **`scripts/deploy-preprod.sh`** |

## Production — only this path

```bash
cd ~/array-operator
# commit your public/ changes to main first
scripts/deploy-and-verify.sh
```

What it does:

1. `git archive HEAD public` → clean tree (no root `netlify.toml`, no edge functions)
2. REST digest upload via `netlify_deploy_dir.py`
3. Post-deploy: asserts **no** edge functions on the live deploy + curls the site
4. Runs onboarding verify gate

**Never:**

```bash
# FORBIDDEN on prod — this is what took the product down
netlify deploy --prod --dir public --site 966cb1f5-944e-41fd-855b-10053edc5d18
netlify deploy --prod   # from repo root against linked prod site
```

## Preprod — only this path

```bash
scripts/deploy-preprod.sh
```

Stages preprod `netlify.toml` (with the IP gate) into a temp dir and deploys to
the **preview** site only. Refuses the production site UUID.

## After every prod deploy — smoke check

```bash
# Must be 200 and must NOT contain "Private preview"
curl -sS -o /tmp/ao.html -w "%{http_code}\n" https://arrayoperator.com/
grep -i "Private preview\|preprod environment" /tmp/ao.html && echo "FAIL GATE ON PROD" || echo "ok"
```

`deploy-and-verify.sh` runs an equivalent check automatically.

## Why the CLI is dangerous here

`netlify deploy --dir public` still reads **`./netlify.toml` from the current
working directory**. A preprod-shaped toml with `[[edge_functions]] path = "/*"`
will ship the Private Preview gate to whatever `--site` you pass — including prod.

Root `netlify.toml` no longer contains edge functions (structural fix). The gate
config lives only in `scripts/preprod/netlify.toml` and is copied in by
`deploy-preprod.sh`.

## Agents / humans

If you are an agent: **do not invent Netlify deploy commands.** Call
`scripts/deploy-and-verify.sh` (prod) or `scripts/deploy-preprod.sh` (preprod).
If either script fails, stop and report — do not fall back to raw `netlify deploy --prod`.

## Sovereign chamber (false-real product — never production)

Always-on sandbox URL for the rocket-engine mind (L2):

| | |
|--|--|
| **URL** | https://chamber--array-operator-ea.netlify.app |
| **How** | Netlify **branch deploy** (`branch=chamber`, `draft=true`) on the **same** site UUID as prod — does **not** publish arrayoperator.com |
| **Command** | `python3 scripts/chamber_deploy_dir.py [public-dir]` |
| **Auto** | Sovereign sandbox AO ships call this via `energy_agent_sovereign_chamber.py` |

New Netlify sites are blocked by plan quota (429). Do **not** create `ao-sovereign-chamber`. Do **not** use preprod (IP gate). Chamber ships `public/` only (includes `_redirects` so `/v1/*` still proxies to Railway).
