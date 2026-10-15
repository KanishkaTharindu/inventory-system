# Heritage Inventory System

A Django application for managing office supplies, purchases, staff issues, branch requests,
dispatches, stock movements, reports, users, roles, and audit history. The application uses
server-rendered Django pages and SQLite by default; it does not require Node.js or MongoDB.

## Requirements

- Python 3.10 or newer
- pip

## Run locally on Windows

Open PowerShell in the repository folder and run:

```powershell
py -3 -m pip install -r requirements.txt
py -3 manage.py migrate
py -3 manage.py seed_system
py -3 manage.py createsuperuser
py -3 manage.py runserver
```

If the Python launcher is unavailable, install with `python -m pip install -r requirements.txt`
and replace `py -3 manage.py` with `python manage.py` for the Django commands. Open
<http://127.0.0.1:8000> and sign in with the Super Admin created by `createsuperuser`.

`seed_system` creates the protected main office (`NUG`), starter categories, the initial
settings record, and the three editable default roles: Stock Officer, Viewer / Approver, and
Branch User. It is safe to run again. Create the Super Admin separately so no default password
is ever installed.

For unattended setup, set both `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` before running
`py -3 manage.py seed_system`. The password must be at least 10 characters. Keep secrets out of
source control.

## Main modules

- **Dashboard** — low-stock items, stock totals, monthly received-purchase spend, pending
  requests and dispatches, and recent movements.
- **Items and categories** — catalog, generated `ITM-0001`-style codes, units, minimum levels,
  cost, and low/out-of-stock indicators.
- **Suppliers and purchases** — record orders, receive whole or partial deliveries, and cancel
  only orders that have not been received.
- **Office issues** — issue supplies to a person or department and cancel an issue through
  compensating stock movements.
- **Branch requests and dispatches** — submit and review line-by-line requests; dispatch
  approved quantities, record branch receipts, and settle damaged or missing goods.
- **Stock and movements** — per-location balances, the last 30 days of movement detail,
  in-transit quantities, and signed corrections.
- **Reports** — stock/value, received purchases, office usage, and dispatch reports, each
  downloadable as CSV.
- **Administration** — manage branches, users, custom roles and per-user permissions; set the
  company name and branch/audit switches; inspect or clear audit entries for an explicit date
  range.

Every user can change their own password from the top bar. Super Admin-only settings and
administration pages are not exposed to ordinary users.

## Stock and access rules

1. Stock on hand is calculated as the sum of append-only ledger movements. The system never
   accepts a directly typed balance.
2. Receipts, issues, dispatches, receipt confirmations, and corrections write their related
   records and ledger movements inside database transactions.
3. Ordinary stock removals are rejected if they would make a location's quantity negative.
4. Cancelling an office issue writes compensating movement rows linked to the originals;
   existing movement history is not edited.
5. A dispatch moves stock from the main office to an in-transit location. Branch receipt moves
   only confirmed quantities into branch stock. Differences remain in transit until settled.
6. Catalog and branch records are deactivated rather than removed after use. Main-office
   records cannot be deactivated or converted into branches.
7. Branch-side users are restricted to their assigned branch by server-side query and workflow
   checks; the branch module must be enabled before requests or dispatches can be used.
8. The system prevents deactivating the currently signed-in user and the last active Super
   Admin.
9. Audit history is append-only in application workflows. Only a Super Admin can clear an
   explicitly selected date range.

## Roles and permissions

Roles have a side (main office or branch) and a set of feature permissions. A user's assigned
permissions can be customized independently of the role defaults. The built-in Super Admin
always has full access. The default Branch User role is limited to creating requests and
receiving dispatches. The branch module is disabled until enabled in Settings.

## Project structure

```text
config/                 Django settings, root URLs, WSGI and ASGI
inventory/
  management/commands/  idempotent system seed command
  migrations/           database schema
  templates/            server-rendered pages
  forms.py              input validation and forms
  models.py             users, catalog, workflows and stock ledger
  services.py           transactional inventory business rules
  urls.py               application routes
  views.py              authentication, pages and workflows
static/                 application styles
manage.py               Django command-line entry point
requirements.txt        Python dependencies
```

## Configuration and maintenance

The default database is `db.sqlite3` in the repository root. Set `DJANGO_DB_PATH` to use a
different SQLite file. Other environment settings:

| Variable | Purpose |
|---|---|
| `DJANGO_SECRET_KEY` | Secret key; set a private random value outside local development |
| `DJANGO_DEBUG` | Debug mode (`true` locally; set `false` when deployed) |
| `DJANGO_ALLOWED_HOSTS` | Comma-separated host names allowed to serve the application |
| `DJANGO_TIME_ZONE` | Time zone (defaults to `Asia/Colombo`) |

Useful commands:

```powershell
py -3 manage.py check
py -3 manage.py test
py -3 manage.py makemigrations
py -3 manage.py migrate
py -3 manage.py seed_system
```

Before deploying, set a secure `DJANGO_SECRET_KEY`, disable debug mode, set the allowed hosts,
configure HTTPS, and review the database and backup strategy for the deployment environment.
