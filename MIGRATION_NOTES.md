# Migration notes

## What was ported

Everything in the original server and client: sign-in with lockout (5 failed attempts) and a 30-per-15-minute
per-IP rate limit; Super Admin plus stored roles with per-user feature ticks (implied permissions, main-office
and branch sides); branches (one main office), users, settings (branch module switch, audit-logging switch,
company name); append-only audit log with filters and range clearing; items, categories, suppliers;
purchases with partial receiving and last-cost update; office issues with cancel-by-reversal; stock with
corrections; branch requests with review; dispatches with receive (damaged/short) and close (write off /
return to main); dashboard; four reports with CSV (BOM + formula-injection guard) and print; the 30-day
ledger retention job; seed, sample-data and clear commands.

Business rules (stock checks, receipt/dispatch/close plans, last-admin and main-office protection, branch-module
switch guard, report grouping) live in `core/rules/*` as plain Python and are unit-tested in
`core/tests/test_rules.py` (35 tests).

## Deliberate differences

* **Modals became pages.** Every create/edit/review/receive dialog is now its own page with the same fields and rules.
* **Locking.** MongoDB used counter documents as locks. Django locks the affected `Item` rows (`select_for_update`,
  always in id order) inside the transaction. SQLite ignores the hint but serialises writers; use PostgreSQL for
  many simultaneous users.
* **Branch deletion** also refuses when documents (purchases, issues, requests, dispatches) still point at it,
  because those foreign keys are protected.
* **Date filters** use whole local days in `TIME_ZONE`.
* **Document numbers** are generated inside the same transaction as the document.
* **API removed.** There is no JSON API; the browser talks to Django views directly. Only `/health/` and the
  cleanup URL return JSON.

## Existing data

* **Passwords cannot be carried over** (bcrypt hashes from the old app are not Django hashes). Users must be
  re-created or given a reset password.
* **No MongoDB importer is included.** The schema maps one-to-one (collections → tables, embedded `lines` → `*Line`
  tables, ObjectIds → integer ids), so an importer can be written against an export of your data. Balances are
  derived from the ledger, so import `StockLedger` rows exactly as they are.

## Security

* The uploaded zip contained `server/.env` with live-looking secrets (database password, JWT secret). It was
  **not copied** into this project. Treat those values as exposed: **rotate the database password and the JWT
  secret**, and remove the file from version control history.
* Set a strong `DJANGO_SECRET_KEY` and `CRON_SECRET`, and keep `.env` out of git (`.gitignore` already does).

## Verification status

The sandbox this was built in could not install Django, so **the Django code has not been executed**. What was
checked: all Python compiles; the pure rules pass 35 unit tests; every template has balanced tags, loads its
tag library and links only to URL names that exist; all project imports resolve; the JavaScript parses.
The Django `TestCase` suites (`core/tests/test_flows.py`, `test_views.py`) are written but have not been run.
Run `python manage.py test` first and expect to fix small things.
