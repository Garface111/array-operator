# Feature #2: CSV Export for Arrays List

## Implementation Plan (minimal, S effort)
- Add `GET /v1/account/clients/{client_id}/arrays.csv` in solar-operator `api/account.py`.
- Use Python `csv` module + `Array` model fields (name, nepool_gis_id, region, fuel_type, excluded, notes, ...).
- Stream response (text/csv).
- In array-operator `public/` (ArrayList.tsx or arrays tab JS): add one-line "Export CSV" button that hits the .csv endpoint.
- Reuse existing CSV ingest pattern from daily-csv.
- No schema, auth, or model changes needed.

Status: ready to ship (full authority granted).