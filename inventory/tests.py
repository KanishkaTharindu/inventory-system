from decimal import Decimal

from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from .models import (
    Branch,
    Category,
    Dispatch,
    Item,
    Role,
    StockLedger,
    StockRequest,
    Supplier,
    SupplierPurchase,
    SystemSetting,
    User,
)
from .forms import SignInForm
from .services import (
    WorkflowError,
    cancel_issue,
    close_dispatch,
    create_dispatch,
    create_issue,
    create_purchase,
    create_request,
    get_balance,
    receive_dispatch,
    receive_purchase,
    review_request,
)


class InventoryWorkflowTests(TestCase):
    def setUp(self):
        self.main = Branch.objects.create(name="Main Office", code="NUG", kind=Branch.MAIN)
        self.branch = Branch.objects.create(name="Kandy Branch", code="KAN", kind=Branch.BRANCH)
        self.main_role = Role.objects.create(
            key="stock-officer",
            name="Stock Officer",
            side=Branch.MAIN,
            permissions=[
                "items.view", "items.manage", "suppliers.view", "suppliers.manage",
                "purchases.view", "purchases.manage", "purchases.receive", "issues.view",
                "issues.manage", "stock.view", "stock.adjust", "reports.view",
                "requests.review", "dispatches.manage",
            ],
        )
        self.branch_role = Role.objects.create(
            key="branch-user",
            name="Branch User",
            side=Branch.BRANCH,
            permissions=["requests.create", "dispatches.receive", "items.view", "stock.view"],
        )
        self.main_user = User.objects.create_user(
            "stock@example.com", "A-valid-password-123", name="Stock Officer",
            branch=self.main, role=self.main_role,
        )
        self.branch_user = User.objects.create_user(
            "branch@example.com", "A-valid-password-123", name="Branch User",
            branch=self.branch, role=self.branch_role,
        )
        self.category = Category.objects.create(name="Stationery")
        self.item = Item.objects.create(
            code="ITM-0001", name="Paper", category=self.category, unit="ream", min_stock=2,
            last_unit_cost=Decimal("10.00"),
        )
        self.supplier = Supplier.objects.create(name="Paper Supply")

    def seed_stock(self, branch, quantity):
        return StockLedger.objects.create(
            item=self.item,
            branch=branch,
            quantity_change=quantity,
            movement_type=StockLedger.OPENING_BALANCE,
            reason="Test opening balance",
        )

    def test_partial_purchase_receipt_updates_ledger_and_status(self):
        purchase = create_purchase(
            supplier=self.supplier,
            purchase_date=timezone.localdate(),
            invoice_ref="INV-1",
            notes="",
            lines=[(self.item, 10, Decimal("12.50"))],
            user=self.main_user,
        )
        line = purchase.lines.get()

        receive_purchase(purchase_id=purchase.pk, quantities={line.pk: 4}, user=self.main_user)
        purchase.refresh_from_db()
        self.assertEqual(purchase.status, SupplierPurchase.PARTLY_RECEIVED)
        self.assertEqual(get_balance(self.item, self.main), 4)
        self.assertEqual(Item.objects.get(pk=self.item.pk).last_unit_cost, Decimal("12.50"))

        receive_purchase(purchase_id=purchase.pk, quantities={line.pk: 6}, user=self.main_user)
        purchase.refresh_from_db()
        self.assertEqual(purchase.status, SupplierPurchase.RECEIVED)
        self.assertEqual(get_balance(self.item, self.main), 10)

    def test_purchase_over_receipt_is_rejected_without_stock_change(self):
        purchase = create_purchase(
            supplier=self.supplier,
            purchase_date=timezone.localdate(),
            invoice_ref="",
            notes="",
            lines=[(self.item, 2, Decimal("1.00"))],
            user=self.main_user,
        )
        line = purchase.lines.get()
        with self.assertRaises(WorkflowError):
            receive_purchase(purchase_id=purchase.pk, quantities={line.pk: 3}, user=self.main_user)
        self.assertEqual(get_balance(self.item, self.main), 0)

    def test_issue_cancellation_is_a_single_compensating_movement(self):
        self.seed_stock(self.main, 10)
        issue = create_issue(
            recipient="Alex", department="Accounts", issue_date=timezone.localdate(),
            branch=self.main, purpose="Work supplies", lines=[(self.item, 4)], user=self.main_user,
        )
        self.assertEqual(get_balance(self.item, self.main), 6)
        original = StockLedger.objects.get(source_id=issue.pk, movement_type=StockLedger.ISSUE)
        cancel_issue(issue_id=issue.pk, reason="Wrong person", user=self.main_user)
        self.assertEqual(get_balance(self.item, self.main), 10)
        reversal = StockLedger.objects.get(
            movement_type=StockLedger.ISSUE_REVERSAL, source_id=issue.pk
        )
        self.assertEqual(reversal.reversal_of_id, original.pk)
        with self.assertRaises(WorkflowError):
            cancel_issue(issue_id=issue.pk, reason="Repeat", user=self.main_user)

    def test_issue_and_adjustment_cannot_drive_stock_below_zero(self):
        with self.assertRaises(WorkflowError):
            create_issue(
                recipient="Alex", department="", issue_date=timezone.localdate(),
                branch=self.main, purpose="", lines=[(self.item, 1)], user=self.main_user,
            )

    def test_duplicate_issue_lines_cannot_bypass_stock_check(self):
        self.seed_stock(self.main, 10)
        with self.assertRaises(WorkflowError):
            create_issue(
                recipient="Alex", department="", issue_date=timezone.localdate(),
                branch=self.main, purpose="",
                lines=[(self.item, 6), (self.item, 6)], user=self.main_user,
            )
        self.assertEqual(get_balance(self.item, self.main), 10)

    def test_request_dispatch_receipt_and_difference_settlement(self):
        self.seed_stock(self.main, 10)
        request = create_request(
            branch=self.branch, notes="", lines=[(self.item, 5, "")], user=self.branch_user
        )
        request_line = request.lines.get()
        review_request(
            request_id=request.pk,
            decisions={str(request_line.pk): (5, "")},
            user=self.main_user,
        )
        dispatch = create_dispatch(
            destination=self.branch,
            request_obj=request,
            dispatch_date=timezone.localdate(),
            lines=[(self.item, 5)],
            user=self.main_user,
        )
        line = dispatch.lines.get()
        request.refresh_from_db()
        self.assertEqual(request.status, StockRequest.COMPLETED)
        self.assertEqual(get_balance(self.item, self.main), 5)
        self.assertEqual(get_balance(self.item, None, in_transit=True), 5)

        receive_dispatch(
            dispatch_id=dispatch.pk, results={str(line.pk): (3, 1)}, user=self.branch_user
        )
        dispatch.refresh_from_db()
        self.assertEqual(dispatch.status, Dispatch.RECEIVED_WITH_DIFFERENCES)
        self.assertEqual(get_balance(self.item, self.branch), 3)
        self.assertEqual(get_balance(self.item, None, in_transit=True), 2)

        close_dispatch(dispatch_id=dispatch.pk, return_to_stock=True, user=self.main_user)
        dispatch.refresh_from_db()
        self.assertEqual(dispatch.status, Dispatch.CLOSED)
        self.assertEqual(get_balance(self.item, None, in_transit=True), 0)
        self.assertEqual(get_balance(self.item, self.main), 7)

    def test_branch_item_page_only_shows_its_own_stock(self):
        self.seed_stock(self.main, 20)
        self.seed_stock(self.branch, 3)
        self.client.force_login(self.branch_user)

        response = self.client.get(reverse("items"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "<td>3</td>", html=True)
        self.assertNotContains(response, "<td>23</td>", html=True)

    def test_item_catalog_does_not_show_stock_without_stock_permission(self):
        self.seed_stock(self.branch, 3)
        self.branch_user.permissions = ["items.view"]
        self.branch_user.save(update_fields=["permissions"])
        self.client.force_login(self.branch_user)

        response = self.client.get(reverse("items"))

        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, "<th>On hand</th>", html=True)

    def test_non_admin_cannot_open_administration_pages(self):
        self.client.force_login(self.main_user)
        self.assertEqual(self.client.get(reverse("branches")).status_code, 403)

    def test_super_admin_pages_render(self):
        admin = User.objects.create_superuser(
            "admin@example.com", "A-valid-password-123", name="Administrator",
            branch=self.main,
        )
        self.client.force_login(admin)
        for name in ("branches", "users", "roles", "settings", "audit"):
            with self.subTest(page=name):
                self.assertEqual(self.client.get(reverse(name)).status_code, 200)

    def test_inventory_pages_render(self):
        settings = SystemSetting.current()
        settings.branch_module_enabled = True
        settings.save(update_fields=["branch_module_enabled"])
        self.client.force_login(self.main_user)
        for name in (
            "dashboard", "items", "suppliers", "purchases", "issues",
            "requests", "dispatches", "stock", "reports",
        ):
            with self.subTest(page=name):
                self.assertEqual(self.client.get(reverse(name)).status_code, 200)

    def test_stock_report_can_be_downloaded_as_csv(self):
        self.seed_stock(self.main, 10)
        self.client.force_login(self.main_user)
        response = self.client.get(reverse("reports"), {"download": "1"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/csv")
        self.assertIn(b"ITM-0001", response.content)

    def test_failed_signins_temporarily_lock_the_account(self):
        for _ in range(5):
            form = SignInForm(data={
                "username": self.main_user.email,
                "password": "not-the-password",
            })
            self.assertFalse(form.is_valid())
        self.main_user.refresh_from_db()
        self.assertEqual(self.main_user.failed_logins, 5)
        self.assertIsNotNone(self.main_user.locked_until)

        locked_form = SignInForm(data={
            "username": self.main_user.email,
            "password": "A-valid-password-123",
        })
        self.assertFalse(locked_form.is_valid())
        self.assertIn("temporarily locked", str(locked_form.errors).lower())

    def test_email_signin_is_case_insensitive(self):
        form = SignInForm(data={
            "username": self.main_user.email.upper(),
            "password": "A-valid-password-123",
        })
        self.assertTrue(form.is_valid(), form.errors)
        self.assertEqual(form.get_user().pk, self.main_user.pk)

    def test_stock_ledger_rows_are_append_only(self):
        row = self.seed_stock(self.main, 10)
        row.quantity_change = 9
        with self.assertRaises(ValueError):
            row.save()
        with self.assertRaises(ValueError):
            row.delete()
