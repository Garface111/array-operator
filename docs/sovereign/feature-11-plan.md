# Feature #11 Ship Plan (bills data repository)

- Backend: verify uncommitted GET /v1/tenants/{tid}/bills + TDD (provider/account_number/account_nickname already exposed).
- Frontend: reuse BillingReportsTab.tsx History collapsible pattern in AccountTab to group bills by `provider`.
- Minimal: add grouped <details> list (vendor header + account sub-rows) under Whole Account tab.
- No model/migration changes needed. Mark shipped post-deploy.