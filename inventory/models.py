from django.contrib.auth.models import AbstractUser
from django.contrib.auth.base_user import BaseUserManager
from django.db import models
from django.db.models import Q
from django.utils import timezone


class Branch(models.Model):
    MAIN = "main"
    BRANCH = "branch"
    TYPE_CHOICES = [(MAIN, "Main office"), (BRANCH, "Branch")]

    name = models.CharField(max_length=120, unique=True)
    code = models.CharField(max_length=20, unique=True)
    kind = models.CharField(max_length=10, choices=TYPE_CHOICES, default=BRANCH)
    address = models.TextField(blank=True)
    phone = models.CharField(max_length=40, blank=True)
    active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["kind"], condition=Q(kind="main"), name="one_main_office"
            )
        ]
        ordering = ["kind", "name"]

    def __str__(self):
        return f"{self.name} ({self.code})"


class Role(models.Model):
    MAIN = Branch.MAIN
    BRANCH = Branch.BRANCH
    SIDE_CHOICES = Branch.TYPE_CHOICES

    key = models.SlugField(max_length=50, unique=True)
    name = models.CharField(max_length=80, unique=True)
    description = models.CharField(max_length=250, blank=True)
    side = models.CharField(max_length=10, choices=SIDE_CHOICES, default=MAIN)
    permissions = models.JSONField(default=list, blank=True)
    built_in = models.BooleanField(default=False)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class UserManager(BaseUserManager):
    use_in_migrations = True

    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError("An email address is required.")
        user = self.model(email=self.normalize_email(email).lower(), **extra_fields)
        if password:
            user.set_password(password)
        else:
            user.set_unusable_password()
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        if not password:
            raise ValueError("A password is required for a Super Admin.")
        if not extra_fields.get("branch_id") and not extra_fields.get("branch"):
            main = Branch.objects.filter(kind=Branch.MAIN).first()
            if main is None:
                raise ValueError("Create the main office before creating the first Super Admin.")
            extra_fields["branch"] = main
        extra_fields.setdefault("name", email)
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        extra_fields.setdefault("is_active", True)
        if not extra_fields["is_staff"] or not extra_fields["is_superuser"]:
            raise ValueError("Super Admin accounts must have staff and superuser status.")
        return self.create_user(email, password, **extra_fields)


class User(AbstractUser):
    username = None
    email = models.EmailField(unique=True)
    name = models.CharField(max_length=120)
    branch = models.ForeignKey(Branch, on_delete=models.PROTECT, related_name="users")
    role = models.ForeignKey(
        Role, null=True, blank=True, on_delete=models.SET_NULL, related_name="users"
    )
    permissions = models.JSONField(null=True, blank=True)
    failed_logins = models.PositiveSmallIntegerField(default=0)
    locked_until = models.DateTimeField(null=True, blank=True)

    objects = UserManager()
    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["name"]

    def save(self, *args, **kwargs):
        self.email = self.__class__.objects.normalize_email(self.email).strip().lower()
        return super().save(*args, **kwargs)

    def has_feature(self, feature):
        if self.is_superuser:
            return True
        assigned = self.permissions
        if assigned is None:
            assigned = self.role.permissions if self.role_id else []
        return feature in assigned

    @property
    def side(self):
        return self.role.side if self.role_id else Branch.MAIN

    def __str__(self):
        return self.name or self.email


class Category(models.Model):
    name = models.CharField(max_length=80, unique=True)
    active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class Supplier(models.Model):
    name = models.CharField(max_length=120, unique=True)
    contact = models.CharField(max_length=120, blank=True)
    phone = models.CharField(max_length=40, blank=True)
    active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class Item(models.Model):
    code = models.CharField(max_length=30, unique=True)
    name = models.CharField(max_length=120)
    category = models.ForeignKey(Category, on_delete=models.PROTECT, related_name="items")
    unit = models.CharField(max_length=30, default="each")
    min_stock = models.PositiveIntegerField(default=0)
    last_unit_cost = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return f"{self.code} — {self.name}"


class SupplierPurchase(models.Model):
    ORDERED = "ordered"
    PARTLY_RECEIVED = "partly_received"
    RECEIVED = "received"
    CANCELLED = "cancelled"
    STATUS_CHOICES = [
        (ORDERED, "Ordered"),
        (PARTLY_RECEIVED, "Partly received"),
        (RECEIVED, "Received"),
        (CANCELLED, "Cancelled"),
    ]

    number = models.CharField(max_length=30, unique=True)
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="purchases")
    purchase_date = models.DateField(default=timezone.localdate)
    invoice_ref = models.CharField(max_length=100, blank=True)
    branch = models.ForeignKey(
        Branch, null=True, blank=True, on_delete=models.PROTECT, related_name="purchases"
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=ORDERED)
    notes = models.TextField(blank=True)
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="purchases")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-purchase_date", "-id"]

    def __str__(self):
        return self.number


class PurchaseLine(models.Model):
    purchase = models.ForeignKey(SupplierPurchase, on_delete=models.CASCADE, related_name="lines")
    item = models.ForeignKey(Item, on_delete=models.PROTECT, related_name="purchase_lines")
    quantity_ordered = models.PositiveIntegerField()
    quantity_received = models.PositiveIntegerField(default=0)
    unit_cost = models.DecimalField(max_digits=12, decimal_places=2)

    @property
    def outstanding(self):
        return self.quantity_ordered - self.quantity_received


class OfficeIssue(models.Model):
    OPEN = "issued"
    CANCELLED = "cancelled"
    STATUS_CHOICES = [(OPEN, "Issued"), (CANCELLED, "Cancelled")]

    number = models.CharField(max_length=30, unique=True)
    recipient = models.CharField(max_length=120)
    department = models.CharField(max_length=120, blank=True)
    issue_date = models.DateField(default=timezone.localdate)
    branch = models.ForeignKey(
        Branch, null=True, blank=True, on_delete=models.PROTECT, related_name="issues"
    )
    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default=OPEN)
    purpose = models.TextField(blank=True)
    issued_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="issues_issued")
    cancelled_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.PROTECT, related_name="issues_cancelled"
    )
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancel_reason = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-issue_date", "-id"]

    def __str__(self):
        return self.number


class IssueLine(models.Model):
    issue = models.ForeignKey(OfficeIssue, on_delete=models.CASCADE, related_name="lines")
    item = models.ForeignKey(Item, on_delete=models.PROTECT, related_name="issue_lines")
    quantity = models.PositiveIntegerField()


class StockRequest(models.Model):
    SUBMITTED = "submitted"
    APPROVED = "approved"
    PARTLY_APPROVED = "partly_approved"
    REJECTED = "rejected"
    CANCELLED = "cancelled"
    COMPLETED = "completed"
    STATUS_CHOICES = [
        (SUBMITTED, "Submitted"),
        (APPROVED, "Approved"),
        (PARTLY_APPROVED, "Partly approved"),
        (REJECTED, "Rejected"),
        (CANCELLED, "Cancelled"),
        (COMPLETED, "Completed"),
    ]

    number = models.CharField(max_length=30, unique=True)
    branch = models.ForeignKey(Branch, on_delete=models.PROTECT, related_name="requests")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=SUBMITTED)
    notes = models.TextField(blank=True)
    requested_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="requests_made")
    reviewed_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.PROTECT, related_name="requests_reviewed"
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]

    def __str__(self):
        return self.number


class RequestLine(models.Model):
    request = models.ForeignKey(StockRequest, on_delete=models.CASCADE, related_name="lines")
    item = models.ForeignKey(Item, on_delete=models.PROTECT, related_name="request_lines")
    quantity_requested = models.PositiveIntegerField()
    quantity_approved = models.PositiveIntegerField(default=0)
    quantity_dispatched = models.PositiveIntegerField(default=0)
    reason = models.CharField(max_length=250, blank=True)

    @property
    def outstanding(self):
        return self.quantity_approved - self.quantity_dispatched


class Dispatch(models.Model):
    IN_TRANSIT = "in_transit"
    RECEIVED_WITH_DIFFERENCES = "received_with_differences"
    RECEIVED = "received"
    CLOSED = "closed"
    STATUS_CHOICES = [
        (IN_TRANSIT, "In transit"),
        (RECEIVED_WITH_DIFFERENCES, "Received with differences"),
        (RECEIVED, "Received"),
        (CLOSED, "Closed"),
    ]

    reference = models.CharField(max_length=30, unique=True)
    request = models.ForeignKey(
        StockRequest, null=True, blank=True, on_delete=models.PROTECT, related_name="dispatches"
    )
    destination = models.ForeignKey(Branch, on_delete=models.PROTECT, related_name="dispatches")
    dispatch_date = models.DateField(default=timezone.localdate)
    status = models.CharField(max_length=30, choices=STATUS_CHOICES, default=IN_TRANSIT)
    dispatched_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="dispatches_sent")
    received_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.PROTECT, related_name="dispatches_received"
    )
    received_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-dispatch_date", "-id"]

    def __str__(self):
        return self.reference


class DispatchLine(models.Model):
    dispatch = models.ForeignKey(Dispatch, on_delete=models.CASCADE, related_name="lines")
    item = models.ForeignKey(Item, on_delete=models.PROTECT, related_name="dispatch_lines")
    quantity_sent = models.PositiveIntegerField()
    quantity_received = models.PositiveIntegerField(default=0)
    quantity_damaged = models.PositiveIntegerField(default=0)
    quantity_short = models.PositiveIntegerField(default=0)
    note = models.CharField(max_length=250, blank=True)


class StockLedger(models.Model):
    PURCHASE = "purchase"
    ISSUE = "issue"
    ISSUE_REVERSAL = "issue_reversal"
    DISPATCH_OUT = "dispatch_out"
    TRANSIT_IN = "transit_in"
    TRANSIT_OUT = "transit_out"
    DISPATCH_RETURN = "dispatch_return"
    ADJUSTMENT = "adjustment"
    OPENING_BALANCE = "opening_balance"
    TYPE_CHOICES = [
        (PURCHASE, "Purchase receipt"),
        (ISSUE, "Office issue"),
        (ISSUE_REVERSAL, "Issue cancellation"),
        (DISPATCH_OUT, "Dispatch from main office"),
        (TRANSIT_IN, "Dispatch in transit"),
        (TRANSIT_OUT, "Received from transit"),
        (DISPATCH_RETURN, "Transit settlement"),
        (ADJUSTMENT, "Stock correction"),
        (OPENING_BALANCE, "Opening balance"),
    ]

    item = models.ForeignKey(Item, on_delete=models.PROTECT, related_name="movements")
    branch = models.ForeignKey(
        Branch, null=True, blank=True, on_delete=models.PROTECT, related_name="movements"
    )
    in_transit = models.BooleanField(default=False)
    quantity_change = models.IntegerField()
    movement_type = models.CharField(max_length=24, choices=TYPE_CHOICES)
    source_type = models.CharField(max_length=40, blank=True)
    source_id = models.PositiveBigIntegerField(null=True, blank=True)
    reason = models.CharField(max_length=250, blank=True)
    note = models.TextField(blank=True)
    reversal_of = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.PROTECT, related_name="reversals"
    )
    created_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.PROTECT, related_name="stock_movements"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["item", "branch", "in_transit"]),
            models.Index(fields=["created_at"]),
        ]

    def delete(self, *args, **kwargs):
        raise ValueError("Stock ledger rows are append-only.")


class SystemSetting(models.Model):
    company_name = models.CharField(max_length=120, default="Our Company")
    branch_module_enabled = models.BooleanField(default=False)
    audit_logging_enabled = models.BooleanField(default=True)
    default_roles_seeded = models.BooleanField(default=False)

    @classmethod
    def current(cls):
        settings, _ = cls.objects.get_or_create(pk=1)
        return settings


class NumberSequence(models.Model):
    key = models.CharField(max_length=20, unique=True)
    value = models.PositiveIntegerField(default=0)


class AuditLog(models.Model):
    user = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="audit_events"
    )
    action = models.CharField(max_length=80)
    record_type = models.CharField(max_length=80, blank=True)
    record_id = models.CharField(max_length=80, blank=True)
    old_value = models.JSONField(null=True, blank=True)
    new_value = models.JSONField(null=True, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
