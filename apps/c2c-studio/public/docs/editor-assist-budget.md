# Editor-Assist Budget

C2C Studio limits `C2C: Explain this region` calls so editor assistance stays
auditable and bounded.

## What The Limit Means

- Each active Studio auth session gets an editor-assist budget.
- The default limit is 3 Explain calls.
- The supported configured range is 1 to 10 calls.
- The BFF also enforces a per-tenant daily ceiling to prevent session churn from
  bypassing the limit.

## When The Budget Is Exhausted

When the budget reaches zero, Studio shows a `budget_exhausted` state in the
Editor-Assist side panel. Select a smaller or more important region for the next
session, or ask an administrator to increase the configured editor-assist limit
for your tenant.

## Audit Trail

Every accepted Explain call writes an `editor_assist` ledger entry with the
region, redaction metadata, budget snapshot, model invocation reference, and
editor-assist reference. The explanation is informational and does not become
part of the productive transformation evidence pack.
