# Office Stock System

This repository contains two ways to run Office Stock:

- **Windows desktop with Supabase:** Follow the complete [desktop setup and troubleshooting guide](desktop/README.md). Each PC runs the Electron app locally and connects directly to the shared Supabase project. No Office Stock server is required.
- **Django web version:** The rest of this README documents the separate Django application. It uses Python and its own `.env` settings. `DB_ENGINE=sqlite` and the other database variables below do not configure the desktop app.

## Django web version

A Django port of the Heritage Office Stock System (formerly Express + MongoDB + React). One server-rendered Django project, no separate API or front-end build.

## Quick start (local)

**Windows (PowerShell, e.g. the VS Code terminal):**

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1    # if blocked: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
pip install -r requirements.txt
Copy-Item .env.example .env     # then choose a unique SEED_ADMIN_PASSWORD of at least 12 characters
python manage.py makemigrations core accounts catalog inventory branchops pettycash
python manage.py migrate
python manage.py seed           # main office, first Super Admin, starter categories, default roles
python manage.py runserver
```

**macOS / Linux (bash):**

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # then choose a unique SEED_ADMIN_PASSWORD of at least 12 characters
python manage.py makemigrations core accounts catalog inventory branchops pettycash
python manage.py migrate
python manage.py seed           # main office, first Super Admin, starter categories, default roles
python manage.py runserver
```

Sign in at http://127.0.0.1:8000/ with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.

> **Migrations are not included.** They must be generated once with the `makemigrations` line above
> (in this order of apps it resolves the dependencies for you). Commit the generated `*/migrations/0001_initial.py`
> files afterwards so every environment uses the same schema.

## Sample data (development only)

Needs `DJANGO_DEBUG=true` in `.env` and a Super Admin (`python manage.py seed` has already made one).

**Load 5 sample records of every kind** (5 branches, 5 users, 5 suppliers, 5 items, 5 purchases, 5 branch requests,
5 dispatches, 5 office issues, 5 petty cash requests, plus the starter categories). It goes through the app's own rules, so stock,
petty cash balances and the audit log are consistent. Main-office work is recorded as the Super Admin; the 5 demo
branch users sign in with `<name>@example.test` and the password `HeritageDemo!2026` (set `SAMPLE_USER_PASSWORD` to change it).

```powershell
# Windows PowerShell (from the project folder, venv activated or not)
.\scripts\load_sample_data.ps1
# or directly:
python manage.py seed_sample_data
```

**Clear everything except the Super Admin.** Deletes all documents, stock, petty cash, audit entries, items, categories,
suppliers, demo users and branches. Keeps the Super Admin account(s), the main office, roles and settings. It asks you to
type the database file name (for example `db.sqlite3`) before deleting; `--yes` skips the question.

```powershell
.\scripts\clear_all_data.ps1
# or directly:
python manage.py clear_all_data
```

To start the demo over: clear, then load again. Loading twice without clearing is refused, so nothing is duplicated.
If PowerShell blocks the `.ps1` files, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use the `python manage.py` lines.

Run the tests:

```bash
python manage.py test                              # needs Django
PYTHONPATH=. python -m unittest core.tests.test_rules   # pure business rules, no Django needed
```

PowerShell equivalent for the pure-rules test:

```powershell
$env:PYTHONPATH = "."
python -m unittest core.tests.test_rules
```

## Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `DJANGO_SECRET_KEY` | Required unless `DJANGO_DEBUG=true`. |
| `DJANGO_DEBUG` | `true` for local development only. |
| `DJANGO_ALLOWED_HOSTS`, `DJANGO_CSRF_TRUSTED_ORIGINS` | Hosts and full origins (with `https://`) when deployed. |
| `DJANGO_SSL_REDIRECT`, `DJANGO_HSTS_SECONDS`, `DJANGO_TRUST_X_FORWARDED_PROTO` | HTTPS and HSTS controls; see the production notes below. |
| `DJANGO_CACHE_BACKEND` | `locmem` by default; use `database` with `createcachetable` for multiple workers. |
| `TIME_ZONE` | Default `Asia/Colombo`. Dates and reports use this zone. |
| `DB_ENGINE` | `sqlite` (default) or `postgres` (+ `DB_NAME/USER/PASSWORD/HOST/PORT/SSLMODE/SSLROOTCERT`). |
| `CRON_SECRET` | Bearer secret for the daily 30-day cleanup URL. |
| `SEED_ADMIN_*`, `SEED_COMPANY_NAME` | Used by `manage.py seed`. |

## Deploying

Use a maintained Python release (3.11 or newer; Python 3.10 reached end of life in October 2026) and install from
`requirements.txt` in the exact virtual environment used by the web app. Update the local Gunicorn before serving
traffic. cPanel hosting varies: use its supported Python app interface and WSGI entry point, or `gunicorn config.wsgi`
behind its HTTPS reverse proxy where available. Do not use `runserver` in production. Serve static files with WhiteNoise
(`python manage.py collectstatic`).

Before deployment, set these values in cPanel's application environment or in a private `.env` outside the public web
root. Do not commit real credentials:

- `DJANGO_DEBUG=false`, a unique random `DJANGO_SECRET_KEY` of at least 50 characters, the exact production hostname in
  `DJANGO_ALLOWED_HOSTS`, and the HTTPS origin in `DJANGO_CSRF_TRUSTED_ORIGINS`.
- `DJANGO_SSL_REDIRECT=true`. This assumes HTTPS is enabled and Django can detect it. Set
  `DJANGO_TRUST_X_FORWARDED_PROTO=true` only if a trusted proxy overwrites client-supplied `X-Forwarded-Proto`.
- Keep `DJANGO_HSTS_SECONDS=0` while setting up HTTPS. After HTTPS and redirects work on every hostname, set it to
  `31536000`. Leave `DJANGO_HSTS_INCLUDE_SUBDOMAINS` and `DJANGO_HSTS_PRELOAD` false unless every affected hostname is
  ready for HSTS. These settings can make an HTTP-only hostname unreachable for a long time.
- Prefer PostgreSQL for a hosted production database. Set `DB_ENGINE=postgres`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`,
  and `DB_HOST`. Use `DB_SSLMODE=verify-full` and `DB_SSLROOTCERT` when the provider supplies a CA certificate; use
  `require` if the provider supports TLS but not certificate verification. Use a dedicated database account and back up
  the database privately.
- Set a long random `CRON_SECRET` if the scheduled cleanup URL is used. Keep `.env`, database files, and backups outside
  `public_html`; restrict their filesystem permissions to the application account.
- The per-IP login throttle uses per-process memory by default. If cPanel runs multiple workers, set
  `DJANGO_CACHE_BACKEND=database` and run `python manage.py createcachetable` once after migrations so all workers
  share the throttle counters. The five-failure account lockout is stored in the database either way.
- Set a unique Super Admin password that passes the 12-character password policy. Rotate any password that was shared,
  weak, or entered into a public or recorded chat.

The repository ignores `.env` and database files. The current `db.sqlite3` has been removed from the Git index while
the local copy is preserved; historical commits still contain database copies. If any copy held real data or password
hashes, treat those records as exposed and rotate affected credentials. Purging old Git history requires a coordinated
history rewrite and does not replace credential rotation.

After setting the production environment, run `python manage.py check --deploy`, `python manage.py migrate`, and
`python manage.py collectstatic` using the production virtual environment. Back up the database before applying
migrations to a populated instance.

**Daily stock-movement cleanup.** Schedule an authenticated `POST` request every day (the original ran at 00:15):

```
POST /maintenance/stock-ledger-retention/
Authorization: Bearer <CRON_SECRET>
```

or run `python manage.py prune_stock_movements` from cron (Task Scheduler on Windows). To test the URL from PowerShell:
`Invoke-WebRequest -Method Post -Headers @{Authorization="Bearer <CRON_SECRET>"} https://your-subdomain.example.com/maintenance/stock-ledger-retention/`. Movements older than 30 days are replaced by one
"opening balance" row per item and location, so stock levels never change.

## Management commands

| Command | What it does |
| --- | --- |
| `seed` | Idempotent first-run setup. |
| `seed_sample_data` | 5 fictional records of every kind, including petty cash (dev only). |
| `clear_all_data` | Deletes everything except the Super Admin(s), main office, roles and settings (dev only; asks for the database name, `--yes` skips). |
| `clear_app_data` | Lighter clean-up: wipes catalog, stock, documents, audit and counters but keeps all users, roles, branches, settings. Dev only; you must type the database name. |
| `prune_stock_movements` | Runs the 30-day cleanup now. |

## Where things live

| App | Contents |
| --- | --- |
| `core` | Settings, audit log, dashboard, CSV, permissions/labels, **pure business rules** (`core/rules`, no Django imports), middleware, template tags |
| `accounts` | Users, roles, branches, sign-in with lockout, change/reset password |
| `catalog` | Items, categories, suppliers |
| `inventory` | Ledger, purchases (partial receiving), office issues (cancel by reversal), stock page, corrections, 30-day cleanup |
| `branchops` | Branch requests with review, dispatches with receive/close |
| `pettycash` | Petty cash for the main office and every branch: requests, manager approval, spending, cash book, low-cash level |
| `reports` | Current stock, purchases, usage, dispatches; CSV and print |

## Petty cash

Open **Petty Cash** in the menu. The main office and every branch hold their own petty cash for buying inventory items.

1. A user with *Own petty cash* (`petty_cash.request`) raises a request for an amount.
2. A manager with *Petty cash: Approve requests* (`petty_cash.approve`) approves it (optionally a smaller amount, with a reason) or rejects it.
   Approval means the money was handed over, so the branch balance goes up. Nobody but the Super Admin can approve their own request.
3. The branch records what it spends (*Record spending*); spending cannot exceed the balance and a mistake is cancelled by a reversal.
4. A branch is **low** when its balance is at or below the low level (default Rs. 2,000). Users with *Set the low level*
   (`petty_cash.configure`) change it under Petty Cash → Low level.

Tick these features on a role or user under Roles / Users. Existing roles are not changed automatically; create e.g. a "Manager" role
with *Approve requests* and *Set the low level* ticked. Run `python manage.py migrate` after pulling this change.

See `MIGRATION_NOTES.md` for behaviour that differs from the original and for moving existing data.
