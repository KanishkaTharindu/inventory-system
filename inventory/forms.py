from decimal import Decimal, InvalidOperation

from django import forms
from django.contrib.auth.forms import AuthenticationForm
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.utils import timezone
from datetime import timedelta

from .models import (
    Branch,
    Category,
    Dispatch,
    Item,
    Role,
    StockRequest,
    Supplier,
    SystemSetting,
    User,
)


STAFF_PERMISSIONS = [
    ("items.view", "View items"),
    ("items.manage", "Manage items and categories"),
    ("suppliers.view", "View suppliers"),
    ("suppliers.manage", "Manage suppliers"),
    ("purchases.view", "View purchases"),
    ("purchases.manage", "Create and cancel purchases"),
    ("purchases.receive", "Receive purchases"),
    ("issues.view", "View office issues"),
    ("issues.manage", "Issue and cancel stock"),
    ("stock.view", "View stock and movements"),
    ("stock.adjust", "Correct stock"),
    ("reports.view", "View reports"),
    ("requests.review", "Review branch requests"),
    ("dispatches.manage", "Create and settle dispatches"),
    ("requests.create", "Create branch requests"),
    ("dispatches.receive", "Receive branch dispatches"),
]


class StyledFormMixin:
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for field in self.fields.values():
            field.widget.attrs.setdefault("class", "input")


class SignInForm(StyledFormMixin, AuthenticationForm):
    username = forms.EmailField(label="Email")

    def clean_username(self):
        return self.cleaned_data["username"].strip().lower()

    def clean(self):
        try:
            return super().clean()
        except ValidationError:
            email = self.cleaned_data.get("username")
            user = User.objects.filter(email__iexact=email).first() if email else None
            if user and self.user_cache is None:
                now = timezone.now()
                if user.locked_until and user.locked_until > now:
                    raise ValidationError("Sign-in is temporarily locked. Try again later.") from None
                user.failed_logins += 1
                if user.failed_logins >= 5:
                    user.locked_until = now + timedelta(minutes=15)
                user.save(update_fields=["failed_logins", "locked_until"])
            raise

    def confirm_login_allowed(self, user):
        if user.locked_until and user.locked_until > timezone.now():
            raise ValidationError("Sign-in is temporarily locked. Try again later.")
        super().confirm_login_allowed(user)
        if not user.branch.active:
            raise ValidationError("Your assigned location is inactive. Contact an administrator.")
        if user.role_id and user.branch.kind != user.role.side:
            raise ValidationError("Your assigned role and location do not match. Contact an administrator.")
        if user.failed_logins or user.locked_until:
            user.failed_logins = 0
            user.locked_until = None
            user.save(update_fields=["failed_logins", "locked_until"])


class ItemForm(StyledFormMixin, forms.ModelForm):
    class Meta:
        model = Item
        fields = ["code", "name", "category", "unit", "min_stock", "last_unit_cost"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["code"].required = False
        self.fields["category"].queryset = Category.objects.filter(active=True)
        self.fields["last_unit_cost"].min_value = Decimal("0")

    def clean_code(self):
        return self.cleaned_data["code"].strip().upper()


class CategoryForm(StyledFormMixin, forms.ModelForm):
    class Meta:
        model = Category
        fields = ["name"]


class SupplierForm(StyledFormMixin, forms.ModelForm):
    class Meta:
        model = Supplier
        fields = ["name", "contact", "phone"]


class LinesForm(StyledFormMixin, forms.Form):
    lines = forms.CharField(
        label="Items",
        widget=forms.Textarea(attrs={"rows": 4}),
        help_text="One line per item: ITEM-CODE, quantity. For purchases add unit cost.",
    )
    needs_cost = False
    needs_reason = False

    def clean_lines(self):
        parsed = []
        by_code = {item.code.upper(): item for item in Item.objects.filter(active=True)}
        for row_number, raw in enumerate(self.cleaned_data["lines"].splitlines(), 1):
            parts = [part.strip() for part in raw.split(",")]
            expected = 3 if self.needs_cost else 2 if self.needs_reason else 2
            if len(parts) != expected:
                suffix = ", unit cost" if self.needs_cost else ""
                raise ValidationError(
                    f"Line {row_number} must be ITEM-CODE, quantity{suffix}."
                )
            item = by_code.get(parts[0].upper())
            if item is None:
                raise ValidationError(f"Line {row_number}: item code {parts[0]!r} is not active.")
            try:
                quantity = int(parts[1])
            except ValueError as exc:
                raise ValidationError(f"Line {row_number}: quantity must be a whole number.") from exc
            if quantity < 1:
                raise ValidationError(f"Line {row_number}: quantity must be positive.")
            if self.needs_cost:
                try:
                    unit_cost = Decimal(parts[2])
                except InvalidOperation as exc:
                    raise ValidationError(f"Line {row_number}: invalid unit cost.") from exc
                if not unit_cost.is_finite() or unit_cost < 0:
                    raise ValidationError(f"Line {row_number}: unit cost cannot be negative.")
                parsed.append((item, quantity, unit_cost))
            elif self.needs_reason:
                parsed.append((item, quantity, ""))
            else:
                parsed.append((item, quantity))
        if not parsed:
            raise ValidationError("Add at least one item.")
        if len({row[0].pk for row in parsed}) != len(parsed):
            raise ValidationError("Each item may appear only once; combine its quantities.")
        return parsed


class PurchaseForm(LinesForm):
    supplier = forms.ModelChoiceField(queryset=Supplier.objects.filter(active=True))
    purchase_date = forms.DateField(initial=timezone.localdate, widget=forms.DateInput(attrs={"type": "date"}))
    invoice_ref = forms.CharField(required=False, max_length=100)
    notes = forms.CharField(required=False, widget=forms.Textarea(attrs={"rows": 2}))
    needs_cost = True


class IssueForm(LinesForm):
    recipient = forms.CharField(max_length=120)
    department = forms.CharField(required=False, max_length=120)
    issue_date = forms.DateField(initial=timezone.localdate, widget=forms.DateInput(attrs={"type": "date"}))
    purpose = forms.CharField(required=False, widget=forms.Textarea(attrs={"rows": 2}))
    branch = forms.ModelChoiceField(queryset=Branch.objects.filter(active=True))

    def clean(self):
        cleaned = super().clean()
        branch = cleaned.get("branch")
        if branch and self.user_side == Branch.BRANCH and branch.pk != self.user_branch_id:
            self.add_error("branch", "Branch users may only record issues for their own branch.")
        return cleaned

    def __init__(self, *args, user=None, **kwargs):
        self.user_side = getattr(user, "side", None)
        self.user_branch_id = getattr(user, "branch_id", None)
        super().__init__(*args, **kwargs)
        if self.user_side == Branch.BRANCH:
            self.fields["branch"].queryset = Branch.objects.filter(pk=self.user_branch_id, active=True)


class RequestForm(LinesForm):
    notes = forms.CharField(required=False, widget=forms.Textarea(attrs={"rows": 2}))
    needs_reason = True


class DispatchForm(LinesForm):
    destination = forms.ModelChoiceField(queryset=Branch.objects.filter(active=True, kind=Branch.BRANCH))
    request_obj = forms.ModelChoiceField(queryset=None, required=False, label="Approved request (optional)")
    dispatch_date = forms.DateField(initial=timezone.localdate, widget=forms.DateInput(attrs={"type": "date"}))

    def __init__(self, *args, **kwargs):
        from .models import StockRequest

        super().__init__(*args, **kwargs)
        self.fields["request_obj"].queryset = StockRequest.objects.filter(
            status__in=[StockRequest.APPROVED, StockRequest.PARTLY_APPROVED]
        ).select_related("branch")


class CancelForm(StyledFormMixin, forms.Form):
    reason = forms.CharField(min_length=3, widget=forms.Textarea(attrs={"rows": 2}))


class ReceivePurchaseForm(StyledFormMixin, forms.Form):
    def __init__(self, purchase, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for line in purchase.lines.select_related("item"):
            self.fields[f"line_{line.pk}"] = forms.IntegerField(
                label=f"{line.item} (outstanding: {line.outstanding})",
                min_value=0,
                max_value=line.outstanding,
                initial=0,
            )

    def clean(self):
        cleaned = super().clean()
        if not any(value for key, value in cleaned.items() if key.startswith("line_")):
            raise ValidationError("Enter at least one positive quantity.")
        return cleaned

    def quantities(self):
        return {
            key.removeprefix("line_"): value
            for key, value in self.cleaned_data.items()
            if key.startswith("line_")
        }


class ReviewRequestForm(StyledFormMixin, forms.Form):
    def __init__(self, request_obj, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.requested_by_line = {}
        for line in request_obj.lines.select_related("item"):
            self.requested_by_line[str(line.pk)] = line.quantity_requested
            self.fields[f"approve_{line.pk}"] = forms.IntegerField(
                label=f"{line.item} (requested: {line.quantity_requested})",
                min_value=0,
                max_value=line.quantity_requested,
            )
            self.fields[f"reason_{line.pk}"] = forms.CharField(
                required=False, label="Reason if reduced or rejected"
            )

    def clean(self):
        cleaned = super().clean()
        for key, quantity in cleaned.items():
            if key.startswith("approve_") and quantity is not None:
                line_id = key.removeprefix("approve_")
                reason = cleaned.get(f"reason_{line_id}", "")
                if quantity < self.requested_by_line[line_id] and not reason.strip():
                    raise ValidationError("Enter a reason for every reduced or rejected line.")
        return cleaned

    def decisions(self):
        return {
            key.removeprefix("approve_"): (
                value,
                self.cleaned_data.get(f"reason_{key.removeprefix('approve_')}", ""),
            )
            for key, value in self.cleaned_data.items()
            if key.startswith("approve_")
        }


class DispatchReceiptForm(StyledFormMixin, forms.Form):
    def __init__(self, dispatch, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.sent_by_line = {}
        for line in dispatch.lines.select_related("item"):
            self.sent_by_line[str(line.pk)] = line.quantity_sent
            self.fields[f"received_{line.pk}"] = forms.IntegerField(
                label=f"{line.item} received (sent: {line.quantity_sent})", min_value=0
            )
            self.fields[f"damaged_{line.pk}"] = forms.IntegerField(
                label=f"{line.item} damaged", min_value=0
            )

    def clean(self):
        cleaned = super().clean()
        for key, received in cleaned.items():
            if key.startswith("received_") and received is not None:
                line_id = key.removeprefix("received_")
                damaged = cleaned.get(f"damaged_{line_id}")
                sent = self.sent_by_line[line_id]
                if damaged is not None and received + damaged > sent:
                    self.add_error(key, "Received plus damaged cannot exceed the sent quantity.")
        return cleaned

    def results(self):
        return {
            key.removeprefix("received_"): (
                value,
                self.cleaned_data[f"damaged_{key.removeprefix('received_')}"],
            )
            for key, value in self.cleaned_data.items()
            if key.startswith("received_")
        }


class StockAdjustmentForm(StyledFormMixin, forms.Form):
    item = forms.ModelChoiceField(queryset=Item.objects.filter(active=True))
    branch = forms.ModelChoiceField(queryset=Branch.objects.filter(active=True))
    quantity = forms.IntegerField(help_text="Positive adds stock; negative removes stock.")
    reason = forms.CharField(max_length=250)
    note = forms.CharField(required=False, widget=forms.Textarea(attrs={"rows": 2}))


class BranchForm(StyledFormMixin, forms.ModelForm):
    class Meta:
        model = Branch
        fields = ["name", "code", "kind", "address", "phone", "active"]

    def clean_code(self):
        return self.cleaned_data["code"].strip().upper()

    def clean_kind(self):
        kind = self.cleaned_data["kind"]
        if kind == Branch.MAIN and Branch.objects.exclude(pk=self.instance.pk).filter(
            kind=Branch.MAIN
        ).exists():
            raise ValidationError("There can only be one main office.")
        if self.instance.pk and self.instance.kind == Branch.MAIN and kind != Branch.MAIN:
            raise ValidationError("The main office cannot be converted to a branch.")
        return kind

    def clean_active(self):
        active = self.cleaned_data["active"]
        if self.cleaned_data.get("kind") == Branch.MAIN and not active:
            raise ValidationError("The main office must remain active.")
        if self.instance.pk and self.instance.kind == Branch.MAIN and not active:
            raise ValidationError("The main office cannot be deactivated.")
        if self.instance.pk and not active:
            if self.instance.users.filter(is_active=True).exists():
                raise ValidationError("Move or deactivate users assigned to this branch first.")
            if self.instance.requests.filter(
                status__in=[
                    StockRequest.SUBMITTED,
                    StockRequest.APPROVED,
                    StockRequest.PARTLY_APPROVED,
                ]
            ).exists() or self.instance.dispatches.filter(
                status__in=[Dispatch.IN_TRANSIT, Dispatch.RECEIVED_WITH_DIFFERENCES]
            ).exists():
                raise ValidationError("Resolve this branch's open requests and dispatches first.")
        return active


class RoleForm(StyledFormMixin, forms.ModelForm):
    permissions = forms.MultipleChoiceField(
        choices=STAFF_PERMISSIONS,
        required=False,
        widget=forms.CheckboxSelectMultiple,
    )

    class Meta:
        model = Role
        fields = ["key", "name", "description", "side", "permissions"]

    def clean(self):
        cleaned = super().clean()
        side = cleaned.get("side")
        if self.instance.pk and side and side != self.instance.side:
            incompatible = self.instance.users.exclude(branch__kind=side).exists()
            if incompatible:
                raise ValidationError("Reassign users to matching locations before changing this role's side.")
        return cleaned

    def clean_permissions(self):
        allowed = dict(STAFF_PERMISSIONS)
        selected = set(self.cleaned_data["permissions"])
        selected.update(
            permission
            for permission, dependencies in {
                "items.manage": ["items.view"],
                "suppliers.manage": ["suppliers.view"],
                "purchases.manage": ["purchases.view"],
                "purchases.receive": ["purchases.view"],
                "issues.manage": ["issues.view"],
                "stock.adjust": ["stock.view"],
            }.items()
            if permission in selected
            for permission in dependencies
        )
        return sorted(selected.intersection(allowed))


class UserCreateForm(StyledFormMixin, forms.ModelForm):
    password = forms.CharField(widget=forms.PasswordInput, min_length=10)
    password_confirm = forms.CharField(widget=forms.PasswordInput, min_length=10)

    class Meta:
        model = User
        fields = ["email", "name", "branch", "role", "is_active"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["role"].required = True

    def clean(self):
        cleaned = super().clean()
        if cleaned.get("password") != cleaned.get("password_confirm"):
            self.add_error("password_confirm", "Passwords do not match.")
        elif cleaned.get("password"):
            try:
                validate_password(cleaned["password"], self.instance)
            except ValidationError as exc:
                self.add_error("password", exc)
        role = cleaned.get("role")
        branch = cleaned.get("branch")
        if branch and not branch.active:
            self.add_error("branch", "Users cannot be assigned to an inactive location.")
        if role and branch and role.side == Branch.BRANCH and branch.kind != Branch.BRANCH:
            self.add_error("branch", "Branch-side users must belong to a branch location.")
        if role and branch and role.side == Branch.MAIN and branch.kind != Branch.MAIN:
            self.add_error("branch", "Main-office users must belong to the main office.")
        return cleaned

    def clean_email(self):
        email = self.cleaned_data["email"].strip().lower()
        if User.objects.filter(email__iexact=email).exists():
            raise ValidationError("A user with this email address already exists.")
        return email

    def save(self, commit=True):
        user = super().save(commit=False)
        user.set_password(self.cleaned_data["password"])
        if commit:
            user.save()
        return user


class UserEditForm(StyledFormMixin, forms.ModelForm):
    permissions = forms.MultipleChoiceField(
        choices=STAFF_PERMISSIONS,
        required=False,
        widget=forms.CheckboxSelectMultiple,
    )

    class Meta:
        model = User
        fields = ["email", "name", "branch", "role", "is_active", "permissions"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["role"].required = True
        if self.instance.pk:
            self.fields["permissions"].initial = (
                self.instance.permissions
                if self.instance.permissions is not None
                else self.instance.role.permissions if self.instance.role_id else []
            )

    def clean(self):
        cleaned = super().clean()
        role = cleaned.get("role")
        branch = cleaned.get("branch")
        if branch and not branch.active:
            self.add_error("branch", "Users cannot be assigned to an inactive location.")
        if role and branch and role.side == Branch.BRANCH and branch.kind != Branch.BRANCH:
            self.add_error("branch", "Branch-side users must belong to a branch location.")
        if role and branch and role.side == Branch.MAIN and branch.kind != Branch.MAIN:
            self.add_error("branch", "Main-office users must belong to the main office.")
        return cleaned

    def clean_email(self):
        email = self.cleaned_data["email"].strip().lower()
        if User.objects.filter(email__iexact=email).exclude(pk=self.instance.pk).exists():
            raise ValidationError("A user with this email address already exists.")
        return email


class SettingsForm(StyledFormMixin, forms.ModelForm):
    class Meta:
        model = SystemSetting
        fields = ["company_name", "branch_module_enabled", "audit_logging_enabled"]

    def clean_branch_module_enabled(self):
        enabled = self.cleaned_data["branch_module_enabled"]
        if not enabled:
            from .models import Dispatch, StockRequest

            open_requests = StockRequest.objects.filter(
                status__in=[
                    StockRequest.SUBMITTED,
                    StockRequest.APPROVED,
                    StockRequest.PARTLY_APPROVED,
                ]
            ).exists()
            open_dispatches = Dispatch.objects.filter(
                status__in=[Dispatch.IN_TRANSIT, Dispatch.RECEIVED_WITH_DIFFERENCES]
            ).exists()
            if open_requests or open_dispatches:
                raise ValidationError("Resolve all open requests and dispatches before disabling branches.")
        return enabled


class SimpleItemForm(StyledFormMixin, forms.Form):
    name = forms.CharField(max_length=120)
