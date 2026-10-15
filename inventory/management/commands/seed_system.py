import os

from django.core.management.base import BaseCommand, CommandError
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.db import transaction

from inventory.forms import STAFF_PERMISSIONS
from inventory.models import Branch, Category, Role, SystemSetting, User


DEFAULT_ROLES = [
    {
        "key": "stock-officer",
        "name": "Stock Officer",
        "side": Branch.MAIN,
        "description": "Records stock, handles requests and dispatches",
        "permissions": [key for key, _label in STAFF_PERMISSIONS if key not in {
            "requests.create", "dispatches.receive"
        }],
    },
    {
        "key": "viewer-approver",
        "name": "Viewer / Approver",
        "side": Branch.MAIN,
        "description": "Read-only access to reports and request approvals",
        "permissions": [
            "items.view", "suppliers.view", "purchases.view", "issues.view",
            "stock.view", "reports.view", "requests.review",
        ],
    },
    {
        "key": "branch-user",
        "name": "Branch User",
        "side": Branch.BRANCH,
        "description": "Requests items and confirms receipts for their branch",
        "permissions": ["requests.create", "dispatches.receive"],
    },
]


class Command(BaseCommand):
    help = "Create the main office, starter categories, default roles, and optionally the first Super Admin."

    def add_arguments(self, parser):
        parser.add_argument("--admin-email", default=os.environ.get("SEED_ADMIN_EMAIL"))
        parser.add_argument("--admin-password", default=os.environ.get("SEED_ADMIN_PASSWORD"))
        parser.add_argument("--admin-name", default=os.environ.get("SEED_ADMIN_NAME", "Super Admin"))

    @transaction.atomic
    def handle(self, *args, **options):
        main = Branch.objects.filter(kind=Branch.MAIN).first()
        code_branch = Branch.objects.filter(code="NUG").first()
        if code_branch and code_branch.kind != Branch.MAIN:
            raise CommandError("The NUG branch code is already used by a non-main branch.")
        if main and main.code != "NUG":
            raise CommandError(
                f"The main office already exists with code {main.code}; resolve this before seeding."
            )
        if main is None:
            main = Branch.objects.create(name="Main Office", code="NUG", kind=Branch.MAIN)
        elif not main.active:
            main.active = True
            main.save(update_fields=["active"])
        for name in ["Stationery", "Cleaning", "Electronics", "Furniture", "Other"]:
            Category.objects.get_or_create(name=name)
        settings = SystemSetting.current()
        if not settings.default_roles_seeded:
            for role_data in DEFAULT_ROLES:
                Role.objects.get_or_create(key=role_data["key"], defaults=role_data)
            settings.default_roles_seeded = True
            settings.save(update_fields=["default_roles_seeded"])
        email, password = options["admin_email"], options["admin_password"]
        if password and not email:
            raise CommandError("Provide --admin-email when using --admin-password.")
        if email and not password:
            raise CommandError(
                "No default password is allowed. Set SEED_ADMIN_PASSWORD or provide --admin-password."
            )
        if email and password:
            if len(password) < 10:
                raise CommandError("The initial password must be at least 10 characters.")
            try:
                validate_password(password, User(email=email, name=options["admin_name"]))
            except ValidationError as exc:
                raise CommandError(" ".join(exc.messages)) from exc
            existing = User.objects.filter(email__iexact=email).first()
            if existing and not existing.is_superuser:
                raise CommandError(
                    f"An ordinary user already uses {email}; choose a different Super Admin email."
                )
            if existing:
                self.stdout.write(f"Super Admin {email} already exists; no account changes made.")
            else:
                User.objects.create_superuser(
                    email=email,
                    password=password,
                    name=options["admin_name"],
                    branch=main,
                )
                self.stdout.write(self.style.SUCCESS(f"Created Super Admin {email}."))
        self.stdout.write(self.style.SUCCESS("Inventory system defaults are ready."))
