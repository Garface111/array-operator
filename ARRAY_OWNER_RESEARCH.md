# Array Owner — who they are, what hurts (persona & problem research)

> Source note: web research was unavailable this session (no Firecrawl
> credits), so this is SYNTHESIZED from domain knowledge encoded across the
> solar-operator / sun-mirror repos and the residential/community solar space —
> NOT scraped from live owner forums. Re-run with web credits to validate &
> quote real complaints.

## Who is the Array Operator (owner)?

Not an installer. Not an engineer. A person (or a small org) who *owns* solar
and wants the thing they paid for to keep paying them. Three shapes:

1. **Residential rooftop owner** — bought or financed a home system. Checks the
   vendor app maybe twice a year. Has no idea what "good" looks like.
2. **Prosumer / multi-array owner** — a few sites (a barn, a field, a second
   home), or a community-solar host like Bruce's customers. Juggles separate
   logins. This is the wedge: "one credential, every array."
3. **Small commercial / PPA-lease holder** — has a production guarantee in a
   contract nobody is verifying. Wants proof they're getting what they signed.

## The pain (ranked by how much it hurts)

1. **"Is it even working?"** — THE core anxiety. Vendor apps (SolarEdge
   mySolarEdge, Enphase Enlighten) show a number — "32 kWh today" — but never
   tell you if that number is GOOD or BAD. Owners discover a dead string months
   later at the annual bill spike. Silent underperformance is the killer: a
   tripped optimizer or shaded string quietly bleeds money for a year.
2. **"This app is for installers, not me."** — DC voltage, inverter mode,
   error code 0x21. Jargon with no translation to dollars or action.
3. **"Nobody is watching."** — After the installer leaves, no one proactively
   monitors. The owner is the de-facto monitor with zero tools or expertise.
4. **"What is it actually worth?"** — Owners don't see the full value: energy
   offset + net-metering credits + RECs/SRECs. Most residential owners don't
   even know their RECs are sellable — the installer often pockets them.
5. **"Many systems, many logins."** — No unified, weather-normalized view
   across arrays. Can't compare site to site.
6. **"Warranty claims are on me."** — When hardware fails, the owner must
   notice, document (when did it die, how much did I lose?), and chase the
   claim. Most lack the evidence.
7. **"Am I being ripped off?"** — Lease/PPA owners with unverified production
   guarantees.

## The product thesis: take the work OUT of their hands

Vendor apps make you the analyst. Array Operator makes the agent the analyst and
hands the owner a verdict + the finished paperwork. Dollar-first, plain English,
zero jargon. "Sublime over tool."

### Sick features (done-for-you, not dashboards-for-you)

- **Always watching (ground truth).** Every inverter measured against its own
  fleet under the same sky — weather cancels, so we catch the *silent* loser the
  day it starts, not next year. (peer_index engine — already built.)
- **Plain-English + dollars.** Not "DC fault 0x21" → "Inverter C is down ~9
  kWh/day, about $1.40. Here's why, here's what to do."
- **Claim, pre-drafted.** Dead/faulted unit → we draft the warranty/service
  email with the evidence attached (loss kWh, dates, fault code). One click.
- **REC money found.** Detect owners leaving REC revenue on the table and hand
  them to the NEPOOL Operator side — the umbrella synergy: owner → verifier.
- **One credential, every array.** Paste one SolarEdge account key, all sites
  appear. (Backend `solaredge/discover` — already built.)
- **The annual story, auto-written.** "What your array did this year" — value,
  uptime, caught problems, dollars saved — generated, not assembled.

### The umbrella synergy (why two doors, one backend)

Array Operator (owner) and NEPOOL Operator (verifier/stamping agent) share the
same generation ground truth. An owner who discovers sellable RECs is handed
across to a NEPOOL operator. Two distinct sites, one engine underneath.
