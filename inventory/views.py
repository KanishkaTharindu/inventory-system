import csv
from datetime import date
from datetime import timedelta
from functools import wraps

from django.contrib import messages
from django.contrib.auth import update_session_auth_hash
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import SetPasswordForm
from django.contrib.auth.views import LoginView, PasswordChangeView
from django.core.exceptions import PermissionDenied, ValidationError
from django.db.models import Sum
from django.http import HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse_lazy
from django.utils import timezone
from django.views.decorators.http import require_POST

from .forms import (
    BranchForm,
    CancelForm,
    CategoryForm,
    DispatchForm,
    DispatchReceiptForm,
    IssueForm,
    ItemForm,
    PurchaseForm,
    ReceivePurchaseForm,
    RequestForm,
    ReviewRequestForm,
    RoleForm,
    SettingsForm,
    SignInForm,
    StockAdjustmentForm,
    SupplierForm,
    UserCreateForm,
    UserEditForm,
)
from .models import (
    AuditLog,
    Branch,
    Category,
    Dispatch,
    DispatchLine,
    IssueLine,
    Item,
    OfficeIssue,
    PurchaseLine,
    Role,
    StockLedger,
    StockRequest,
    Supplier,
    SupplierPurchase,
    SystemSetting,
    User,
)
from .services import (
    WorkflowError,
    adjust_stock,
    balances_for,
    cancel_issue,
    cancel_purchase,
    cancel_request,
    close_dispatch,
    create_dispatch,
    create_issue,
    create_purchase,
    create_request,
    get_balance,
    main_branch,
    next_number,
    receive_dispatch,
    receive_purchase,
    review_request,
)


def feature_required(feature):
    def decorate(view):
        @wraps(view)
        @login_required
        def wrapped(request, *args, **kwargs):
            if not request.user.has_feature(feature):
                raise PermissionDenied
            return view(request, *args, **kwargs)

        return wrapped

    return decorate


def superuser_required(view):
    @wraps(view)
    @login_required
    def wrapped(request, *args, **kwargs):
        if not request.user.is_superuser:
            raise PermissionDenied
        return view(request, *args, **kwargs)

    return wrapped


def main_side_required(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        if request.user.side == Branch.BRANCH:
            raise PermissionDenied
        return view(request, *args, **kwargs)

    return wrapped


def audit(request, action, record=None, old_value=None, new_value=None):
    from .services import log_audit

    ip = request.META.get("REMOTE_ADDR")
    log_audit(request.user, action, record, old_value, new_value, ip)


def safe_csv(value):
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
        return f"'{value}"
    return value


def handle_workflow(request, action, *args, **kwargs):
    try:
        return action(*args, **kwargs)
    except (WorkflowError, ValidationError) as exc:
        messages.error(request, " ".join(exc.messages) if hasattr(exc, "messages") else str(exc))
        return None


def branch_queryset_for_user(user, queryset, field="branch"):
    if user.side == Branch.BRANCH:
        return queryset.filter(**{f"{field}_id": user.branch_id})
    return queryset


class InventoryLoginView(LoginView):
    template_name = "registration/login.html"
    authentication_form = SignInForm
    redirect_authenticated_user = True


@login_required
def dashboard(request):
    branch = request.user.branch if request.user.side == Branch.BRANCH else None
    can_view_items = request.user.has_feature("items.view")
    can_view_stock = request.user.has_feature("stock.view")
    can_view_requests = request.user.has_feature("requests.review") or request.user.has_feature("requests.create")
    can_view_dispatches = request.user.has_feature("dispatches.manage") or request.user.has_feature("dispatches.receive")
    rows = balances_for(branch=branch)
    all_items = list(Item.objects.filter(active=True)) if can_view_items else []
    stock_by_item = {}
    for item in all_items:
        stock_by_item[item.pk] = sum(
            qty for (item_id, _branch_id, transit), qty in rows.items()
            if item_id == item.pk and not transit
        )
    low_stock = [
        item for item in all_items
        if stock_by_item[item.pk] <= item.min_stock
    ]
    today = timezone.localdate()
    purchases = SupplierPurchase.objects.filter(
        purchase_date__year=today.year, purchase_date__month=today.month
    )
    open_purchases = SupplierPurchase.objects.filter(
        status__in=[SupplierPurchase.ORDERED, SupplierPurchase.PARTLY_RECEIVED]
    )
    issue_lines = IssueLine.objects.filter(
        issue__status=OfficeIssue.OPEN,
        issue__issue_date__year=today.year,
        issue__issue_date__month=today.month,
    )
    if branch:
        purchases = purchases.filter(branch=branch)
        open_purchases = open_purchases.filter(branch=branch)
        issue_lines = issue_lines.filter(issue__branch=branch)
    purchase_spend = sum(
        line.quantity_received * line.unit_cost
        for line in PurchaseLine.objects.filter(purchase__in=purchases).select_related("purchase")
    )
    requests = StockRequest.objects.all()
    dispatches = Dispatch.objects.all()
    if branch:
        requests = requests.filter(branch=branch)
        dispatches = dispatches.filter(destination=branch)
    movement_queryset = StockLedger.objects.none()
    if can_view_stock:
        movement_queryset = StockLedger.objects.select_related(
            "item", "branch", "created_by"
        ).exclude(movement_type=StockLedger.OPENING_BALANCE)
        if branch:
            movement_queryset = movement_queryset.filter(branch=branch)
    usage_units = issue_lines.aggregate(total=Sum("quantity"))["total"] or 0
    if not request.user.has_feature("issues.view"):
        usage_units = 0
    context = {
        "low_stock": low_stock[:8],
        "stock_by_item": stock_by_item,
        "item_count": len(all_items),
        "total_units": sum(stock_by_item.values()),
        "can_view_items": can_view_items,
        "can_view_stock": can_view_stock,
        "purchase_spend": purchase_spend if request.user.has_feature("purchases.view") else 0,
        "usage_units": usage_units,
        "pending_purchases": open_purchases.count() if request.user.has_feature("purchases.view") else 0,
        "open_requests": requests.filter(
            status__in=[StockRequest.SUBMITTED, StockRequest.APPROVED, StockRequest.PARTLY_APPROVED]
        ).count() if can_view_requests else 0,
        "open_dispatches": dispatches.filter(
            status__in=[Dispatch.IN_TRANSIT, Dispatch.RECEIVED_WITH_DIFFERENCES]
        ).count() if can_view_dispatches else 0,
        "recent_movements": movement_queryset[:10],
    }
    return render(request, "inventory/dashboard.html", context)


@feature_required("items.view")
def items(request):
    item_id = request.GET.get("edit")
    item = get_object_or_404(Item, pk=item_id) if item_id else None
    form = ItemForm(request.POST or None, instance=item)
    if request.method == "POST":
        if not request.user.has_feature("items.manage"):
            raise PermissionDenied
        if form.is_valid():
            item = form.save(commit=False)
            if not item.code:
                item.code = next_number("ITM")
            item.save()
            audit(request, "item.update" if item else "item.create", item)
            messages.success(request, f"Saved {item.name}.")
            return redirect("items")
    item_list = Item.objects.select_related("category").all()
    can_view_stock = request.user.has_feature("stock.view")
    rows = balances_for(
        branch=request.user.branch if request.user.side == Branch.BRANCH else None
    ) if can_view_stock else {}
    stock_by_item = {
        item.pk: sum(qty for (item_id, _branch_id, transit), qty in rows.items() if item_id == item.pk and not transit)
        for item in item_list
    }
    return render(request, "inventory/items.html", {
        "items": item_list, "stock_by_item": stock_by_item, "form": form,
        "categories": Category.objects.all(),
        "category_form": CategoryForm(),
        "editing": item,
        "can_view_stock": can_view_stock,
    })


@feature_required("items.manage")
@require_POST
def add_category(request):
    form = CategoryForm(request.POST)
    if form.is_valid():
        category = form.save()
        audit(request, "category.create", category)
        messages.success(request, "Category added.")
    else:
        messages.error(request, form.errors.as_text())
    return redirect("items")


@feature_required("items.manage")
@require_POST
def deactivate_category(request, category_id):
    category = get_object_or_404(Category, pk=category_id)
    category.active = False
    category.save(update_fields=["active"])
    audit(request, "category.deactivate", category)
    messages.success(request, f"{category.name} was deactivated.")
    return redirect("items")


@feature_required("items.manage")
@require_POST
def deactivate_item(request, item_id):
    item = get_object_or_404(Item, pk=item_id)
    item.active = False
    item.save(update_fields=["active"])
    audit(request, "item.deactivate", item)
    messages.success(request, f"{item.name} was deactivated.")
    return redirect("items")


@feature_required("suppliers.view")
def suppliers(request):
    supplier_id = request.GET.get("edit")
    supplier = get_object_or_404(Supplier, pk=supplier_id) if supplier_id else None
    form = SupplierForm(request.POST or None, instance=supplier)
    if request.method == "POST":
        if not request.user.has_feature("suppliers.manage"):
            raise PermissionDenied
        if form.is_valid():
            supplier = form.save()
            audit(request, "supplier.update" if supplier else "supplier.create", supplier)
            messages.success(request, "Supplier saved.")
            return redirect("suppliers")
    return render(request, "inventory/suppliers.html", {
        "suppliers": Supplier.objects.all(), "form": form, "editing": supplier,
    })


@feature_required("suppliers.manage")
@require_POST
def deactivate_supplier(request, supplier_id):
    supplier = get_object_or_404(Supplier, pk=supplier_id)
    supplier.active = False
    supplier.save(update_fields=["active"])
    audit(request, "supplier.deactivate", supplier)
    messages.success(request, f"{supplier.name} was deactivated.")
    return redirect("suppliers")


@feature_required("purchases.view")
@main_side_required
def purchases(request):
    form = PurchaseForm(request.POST or None)
    if request.method == "POST":
        if not request.user.has_feature("purchases.manage"):
            raise PermissionDenied
        if form.is_valid():
            purchase = handle_workflow(
                request,
                create_purchase,
                supplier=form.cleaned_data["supplier"],
                purchase_date=form.cleaned_data["purchase_date"],
                invoice_ref=form.cleaned_data["invoice_ref"],
                notes=form.cleaned_data["notes"],
                lines=form.cleaned_data["lines"],
                user=request.user,
            )
            if purchase:
                messages.success(request, f"Purchase {purchase.number} recorded.")
                return redirect("purchases")
    return render(request, "inventory/purchases.html", {
        "purchases": SupplierPurchase.objects.select_related("supplier", "created_by").prefetch_related("lines__item"),
        "form": form,
    })


@feature_required("purchases.receive")
@main_side_required
def purchase_receive(request, purchase_id):
    purchase = get_object_or_404(SupplierPurchase, pk=purchase_id)
    form = ReceivePurchaseForm(purchase, request.POST or None)
    if request.method == "POST" and form.is_valid():
        result = handle_workflow(
            request, receive_purchase, purchase_id=purchase.pk,
            quantities=form.quantities(), user=request.user,
        )
        if result:
            messages.success(request, f"Received items for {purchase.number}.")
            return redirect("purchases")
    return render(request, "inventory/action.html", {
        "title": f"Receive {purchase.number}", "form": form, "back_url": "purchases",
    })


@feature_required("purchases.manage")
@main_side_required
@require_POST
def purchase_cancel(request, purchase_id):
    result = handle_workflow(request, cancel_purchase, purchase_id=purchase_id, user=request.user)
    if result:
        messages.success(request, f"Purchase {result.number} cancelled.")
    return redirect("purchases")


@feature_required("issues.view")
def issues(request):
    form = IssueForm(request.POST or None, user=request.user)
    if request.user.side == Branch.BRANCH:
        form.fields["branch"].queryset = Branch.objects.filter(pk=request.user.branch_id)
    if request.method == "POST":
        if not request.user.has_feature("issues.manage"):
            raise PermissionDenied
        if form.is_valid():
            branch = form.cleaned_data["branch"]
            if request.user.side == Branch.BRANCH and branch.pk != request.user.branch_id:
                raise PermissionDenied
            issue = handle_workflow(
                request, create_issue,
                recipient=form.cleaned_data["recipient"],
                department=form.cleaned_data["department"],
                issue_date=form.cleaned_data["issue_date"],
                branch=branch,
                purpose=form.cleaned_data["purpose"],
                lines=form.cleaned_data["lines"],
                user=request.user,
            )
            if issue:
                messages.success(request, f"Issue {issue.number} recorded.")
                return redirect("issues")
    issue_list = OfficeIssue.objects.select_related("branch", "issued_by").prefetch_related("lines__item")
    issue_list = branch_queryset_for_user(request.user, issue_list)
    return render(request, "inventory/issues.html", {"issues": issue_list, "form": form})


@feature_required("issues.manage")
@require_POST
def issue_cancel(request, issue_id):
    issue = get_object_or_404(OfficeIssue.objects.select_related("branch"), pk=issue_id)
    if request.user.side == Branch.BRANCH and issue.branch_id != request.user.branch_id:
        raise PermissionDenied
    form = CancelForm(request.POST)
    if form.is_valid():
        result = handle_workflow(
            request, cancel_issue, issue_id=issue.pk,
            reason=form.cleaned_data["reason"], user=request.user,
        )
        if result:
            messages.success(request, f"Issue {result.number} cancelled and stock restored.")
    else:
        messages.error(request, form.errors.as_text())
    return redirect("issues")


@login_required
def requests_page(request):
    settings = SystemSetting.current()
    if not settings.branch_module_enabled:
        raise PermissionDenied("The branch module is disabled.")
    if request.user.side == Branch.BRANCH:
        if not request.user.has_feature("requests.create"):
            raise PermissionDenied
        form = RequestForm(request.POST or None)
        if request.method == "POST":
            if not request.user.has_feature("requests.create"):
                raise PermissionDenied
            if form.is_valid():
                result = handle_workflow(
                    request, create_request, branch=request.user.branch,
                    notes=form.cleaned_data["notes"], lines=form.cleaned_data["lines"],
                    user=request.user,
                )
                if result:
                    messages.success(request, f"Request {result.number} submitted.")
                    return redirect("requests")
        request_list = StockRequest.objects.filter(branch=request.user.branch)
    else:
        if not request.user.has_feature("requests.review"):
            raise PermissionDenied
        form = None
        request_list = StockRequest.objects.select_related("branch", "requested_by", "reviewed_by")
    return render(request, "inventory/requests.html", {
        "requests": request_list.prefetch_related("lines__item"),
        "form": form,
    })


@feature_required("requests.review")
@main_side_required
def request_review(request, request_id):
    request_obj = get_object_or_404(StockRequest.objects.prefetch_related("lines__item"), pk=request_id)
    form = ReviewRequestForm(request_obj, request.POST or None)
    if request.method == "POST" and form.is_valid():
        result = handle_workflow(
            request, review_request, request_id=request_obj.pk,
            decisions=form.decisions(), user=request.user,
        )
        if result:
            messages.success(request, f"Request {result.number} reviewed.")
            return redirect("requests")
    return render(request, "inventory/action.html", {
        "title": f"Review {request_obj.number}", "form": form, "back_url": "requests",
    })


@feature_required("requests.create")
@require_POST
def request_cancel(request, request_id):
    request_obj = get_object_or_404(StockRequest, pk=request_id)
    if request.user.side != Branch.BRANCH or request_obj.branch_id != request.user.branch_id:
        raise PermissionDenied
    result = handle_workflow(request, cancel_request, request_id=request_obj.pk, user=request.user)
    if result:
        messages.success(request, f"Request {result.number} cancelled.")
    return redirect("requests")


@login_required
def dispatches(request):
    if not SystemSetting.current().branch_module_enabled:
        raise PermissionDenied("The branch module is disabled.")
    if request.user.side == Branch.BRANCH:
        if not request.user.has_feature("dispatches.receive"):
            raise PermissionDenied
        if request.method == "POST":
            raise PermissionDenied
        form = None
        dispatch_list = Dispatch.objects.filter(destination=request.user.branch)
    else:
        if not request.user.has_feature("dispatches.manage"):
            raise PermissionDenied
        form = DispatchForm(request.POST or None)
        if request.method == "POST":
            if not request.user.has_feature("dispatches.manage"):
                raise PermissionDenied
            if form.is_valid():
                request_obj = form.cleaned_data["request_obj"]
                if request_obj and request_obj.branch_id != form.cleaned_data["destination"].pk:
                    form.add_error("request_obj", "Request destination does not match the selected branch.")
                else:
                    result = handle_workflow(
                        request, create_dispatch,
                        destination=form.cleaned_data["destination"],
                        request_obj=request_obj,
                        dispatch_date=form.cleaned_data["dispatch_date"],
                        lines=form.cleaned_data["lines"],
                        user=request.user,
                    )
                    if result:
                        messages.success(request, f"Dispatch {result.reference} sent.")
                        return redirect("dispatches")
        dispatch_list = Dispatch.objects.select_related("destination", "request", "dispatched_by")
    return render(request, "inventory/dispatches.html", {
        "dispatches": dispatch_list.prefetch_related("lines__item"),
        "form": form,
    })


@feature_required("dispatches.receive")
def dispatch_receive(request, dispatch_id):
    dispatch = get_object_or_404(
        Dispatch.objects.prefetch_related("lines__item"), pk=dispatch_id
    )
    if request.user.side == Branch.BRANCH and dispatch.destination_id != request.user.branch_id:
        raise PermissionDenied
    form = DispatchReceiptForm(dispatch, request.POST or None)
    if request.method == "POST" and form.is_valid():
        result = handle_workflow(
            request, receive_dispatch, dispatch_id=dispatch.pk,
            results=form.results(), user=request.user,
        )
        if result:
            messages.success(request, f"Receipt for {result.reference} recorded.")
            return redirect("dispatches")
    return render(request, "inventory/action.html", {
        "title": f"Receive {dispatch.reference}", "form": form, "back_url": "dispatches",
    })


@feature_required("dispatches.manage")
@main_side_required
@require_POST
def dispatch_close(request, dispatch_id):
    returned = request.POST.get("return_to_stock") == "yes"
    result = handle_workflow(
        request, close_dispatch, dispatch_id=dispatch_id,
        return_to_stock=returned, user=request.user,
    )
    if result:
        messages.success(request, f"Dispatch {result.reference} settled.")
    return redirect("dispatches")


@feature_required("stock.view")
def stock(request):
    branch_id = request.GET.get("branch")
    if request.user.side == Branch.BRANCH:
        branch = request.user.branch
    elif branch_id:
        branch = get_object_or_404(Branch, pk=branch_id)
    else:
        branch = main_branch()
    rows = []
    for item in Item.objects.filter(active=True).select_related("category"):
        quantity = get_balance(item, branch)
        rows.append({
            "item": item,
            "quantity": quantity,
            "value": quantity * item.last_unit_cost,
            "low": quantity <= item.min_stock,
        })
    movement_list = StockLedger.objects.filter(branch=branch, in_transit=False).exclude(
        movement_type=StockLedger.OPENING_BALANCE
    ).filter(created_at__gte=timezone.now() - timedelta(days=30)).select_related(
        "item", "created_by"
    )[:100]
    transit = []
    if request.user.side != Branch.BRANCH:
        transit = StockLedger.objects.filter(in_transit=True).values(
            "item__name", "item__code"
        ).annotate(quantity=Sum("quantity_change")).filter(quantity__gt=0)
    return render(request, "inventory/stock.html", {
        "rows": rows, "branch": branch, "branches": Branch.objects.filter(active=True),
        "movements": movement_list, "transit": transit,
        "form": StockAdjustmentForm(),
    })


@feature_required("stock.adjust")
@require_POST
def stock_adjust(request):
    form = StockAdjustmentForm(request.POST)
    if request.user.side == Branch.BRANCH:
        form.fields["branch"].queryset = Branch.objects.filter(pk=request.user.branch_id)
    if form.is_valid():
        branch = form.cleaned_data["branch"]
        if request.user.side == Branch.BRANCH and branch.pk != request.user.branch_id:
            raise PermissionDenied
        result = handle_workflow(
            request, adjust_stock,
            item=form.cleaned_data["item"],
            branch=branch,
            quantity=form.cleaned_data["quantity"],
            reason=form.cleaned_data["reason"],
            note=form.cleaned_data["note"],
            user=request.user,
        )
        if result:
            messages.success(request, "Stock correction recorded.")
    else:
        messages.error(request, form.errors.as_text())
    return redirect("stock")


@feature_required("reports.view")
def reports(request):
    report_type = request.GET.get("report", "stock")
    branch = request.user.branch if request.user.side == Branch.BRANCH else None
    rows = []
    if report_type == "stock":
        balances = balances_for(branch=branch)
        for item in Item.objects.filter(active=True).select_related("category"):
            quantity = sum(
                qty for (item_id, _branch, transit), qty in balances.items()
                if item_id == item.pk and not transit
            )
            rows.append({
                "item": item,
                "quantity": quantity,
                "value": quantity * item.last_unit_cost,
            })
    elif report_type == "purchases":
        if branch:
            raise PermissionDenied
        for line in PurchaseLine.objects.filter(
            purchase__status__in=[SupplierPurchase.RECEIVED, SupplierPurchase.PARTLY_RECEIVED]
        ).select_related("item", "purchase", "purchase__supplier"):
            rows.append({
                "reference": line.purchase.number,
                "supplier": line.purchase.supplier.name,
                "date": line.purchase.purchase_date,
                "item": line.item,
                "quantity": line.quantity_received,
                "value": line.quantity_received * line.unit_cost,
            })
    elif report_type == "usage":
        issue_lines = IssueLine.objects.filter(issue__status=OfficeIssue.OPEN).select_related(
            "item", "issue", "issue__branch"
        )
        if branch:
            issue_lines = issue_lines.filter(issue__branch=branch)
        for line in issue_lines:
            rows.append({
                "reference": line.issue.number,
                "date": line.issue.issue_date,
                "location": line.issue.branch.name if line.issue.branch_id else "Main office",
                "item": line.item,
                "quantity": line.quantity,
                "value": line.quantity * line.item.last_unit_cost,
            })
    elif report_type == "dispatches":
        dispatch_lines = DispatchLine.objects.select_related(
            "item", "dispatch", "dispatch__destination"
        )
        if branch:
            dispatch_lines = dispatch_lines.filter(dispatch__destination=branch)
        for line in dispatch_lines:
            rows.append({
                "reference": line.dispatch.reference,
                "date": line.dispatch.dispatch_date,
                "location": line.dispatch.destination.name,
                "item": line.item,
                "quantity": line.quantity_sent,
                "value": line.quantity_sent * line.item.last_unit_cost,
                "status": line.dispatch.get_status_display(),
            })
    else:
        raise PermissionDenied("Choose a supported report.")
    if request.GET.get("download") == "1":
        response = HttpResponse(content_type="text/csv")
        response["Content-Disposition"] = f'attachment; filename="{report_type}-report.csv"'
        writer = csv.writer(response)

        def write_row(values):
            writer.writerow([safe_csv(value) for value in values])

        if report_type == "stock":
            write_row(["Code", "Item", "Category", "Quantity", "Unit", "Unit cost", "Value"])
            for row in rows:
                write_row([
                    row["item"].code, row["item"].name, row["item"].category.name,
                    row["quantity"], row["item"].unit, row["item"].last_unit_cost, row["value"],
                ])
        elif report_type == "purchases":
            write_row(["Purchase", "Supplier", "Date", "Item code", "Item", "Received", "Value"])
            for row in rows:
                write_row([
                    row["reference"], row["supplier"], row["date"], row["item"].code,
                    row["item"].name, row["quantity"], row["value"],
                ])
        else:
            write_row(["Reference", "Date", "Location", "Item code", "Item", "Quantity", "Value", "Status"])
            for row in rows:
                write_row([
                    row["reference"], row["date"], row["location"], row["item"].code,
                    row["item"].name, row["quantity"], row["value"], row.get("status", ""),
                ])
        return response
    return render(request, "inventory/reports.html", {
        "rows": rows, "report_type": report_type, "is_branch": branch is not None,
    })


@superuser_required
def branches(request):
    branch_id = request.GET.get("edit")
    branch = get_object_or_404(Branch, pk=branch_id) if branch_id else None
    form = BranchForm(request.POST or None, instance=branch)
    if request.method == "POST" and form.is_valid():
        saved = form.save()
        audit(request, "branch.update" if branch else "branch.create", saved)
        messages.success(request, "Branch saved.")
        return redirect("branches")
    return render(request, "inventory/admin_list.html", {
        "title": "Branches", "objects": Branch.objects.all(), "form": form,
        "list_kind": "branches", "editing": branch,
    })


@superuser_required
def roles(request):
    role_id = request.GET.get("edit")
    role = get_object_or_404(Role, pk=role_id) if role_id else None
    if role and role.built_in:
        raise PermissionDenied
    form = RoleForm(request.POST or None, instance=role)
    if request.method == "POST" and form.is_valid():
        saved = form.save()
        audit(request, "role.update" if role else "role.create", saved)
        messages.success(request, "Role saved.")
        return redirect("roles")
    return render(request, "inventory/admin_list.html", {
        "title": "Roles", "objects": Role.objects.all(), "form": form,
        "list_kind": "roles", "editing": role,
    })


@superuser_required
def users(request):
    if request.method == "POST":
        form = UserCreateForm(request.POST)
        if form.is_valid():
            user = form.save()
            audit(request, "user.create", user)
            messages.success(request, f"Added user {user.email}.")
            return redirect("users")
    else:
        form = UserCreateForm()
    return render(request, "inventory/admin_list.html", {
        "title": "Users", "objects": User.objects.select_related("role", "branch"), "form": form,
        "list_kind": "users",
    })


@superuser_required
def user_edit(request, user_id):
    target = get_object_or_404(User, pk=user_id)
    if target.is_superuser:
        raise PermissionDenied
    form = UserEditForm(request.POST or None, instance=target)
    if request.method == "POST" and form.is_valid():
        if target.pk == request.user.pk and (
            not form.cleaned_data["is_active"] or form.cleaned_data["role"] != target.role
        ):
            form.add_error(None, "You cannot deactivate yourself or change your own role.")
        else:
            form.save()
            audit(request, "user.update", target)
            messages.success(request, f"Updated {target.email}.")
            return redirect("users")
    return render(request, "inventory/action.html", {
        "title": f"Edit {target.email}", "form": form, "back_url": "users",
    })


@superuser_required
def user_password(request, user_id):
    target = get_object_or_404(User, pk=user_id)
    form = SetPasswordForm(target, request.POST or None)
    if request.method == "POST" and form.is_valid():
        form.save()
        target.failed_logins = 0
        target.locked_until = None
        target.save(update_fields=["failed_logins", "locked_until"])
        audit(request, "user.password_reset", target)
        messages.success(request, f"Password reset for {target.email}.")
        return redirect("users")
    return render(request, "inventory/action.html", {
        "title": f"Reset password for {target.email}", "form": form, "back_url": "users",
    })


@superuser_required
@require_POST
def user_toggle(request, user_id):
    target = get_object_or_404(User, pk=user_id)
    if target.pk == request.user.pk:
        messages.error(request, "You cannot deactivate your own account.")
        return redirect("users")
    if target.is_superuser and target.is_active and User.objects.filter(
        is_superuser=True, is_active=True
    ).count() <= 1:
        messages.error(request, "The last active Super Admin cannot be deactivated.")
        return redirect("users")
    target.is_active = not target.is_active
    target.save(update_fields=["is_active"])
    audit(request, "user.active_changed", target, new_value={"is_active": target.is_active})
    messages.success(request, f"User {target.email} updated.")
    return redirect("users")


@superuser_required
def settings_page(request):
    setting = SystemSetting.current()
    form = SettingsForm(request.POST or None, instance=setting)
    if request.method == "POST" and form.is_valid():
        form.save()
        audit(request, "settings.update", setting)
        messages.success(request, "Settings saved.")
        return redirect("settings")
    return render(request, "inventory/settings.html", {"form": form})


@superuser_required
@require_POST
def role_delete(request, role_id):
    role = get_object_or_404(Role, pk=role_id)
    if role.built_in:
        raise PermissionDenied
    if role.users.exists():
        messages.error(request, "Reassign users before deleting this role.")
        return redirect("roles")
    audit(request, "role.delete", role)
    role.delete()
    messages.success(request, "Role deleted.")
    return redirect("roles")


@superuser_required
def audit_log(request):
    logs = AuditLog.objects.select_related("user")
    start = request.GET.get("start")
    end = request.GET.get("end")
    try:
        start_date = date.fromisoformat(start) if start else None
        end_date = date.fromisoformat(end) if end else None
    except ValueError:
        messages.error(request, "Choose valid audit filter dates.")
        start_date, end_date = None, None
    if start_date and end_date and start_date > end_date:
        messages.error(request, "The start date must not be after the end date.")
        start_date, end_date = None, None
    if start_date:
        logs = logs.filter(created_at__date__gte=start_date)
    if end_date:
        logs = logs.filter(created_at__date__lte=end_date)
    return render(request, "inventory/audit.html", {
        "logs": logs[:250], "start": start, "end": end,
    })


@superuser_required
@require_POST
def clear_audit(request):
    start, end = request.POST.get("start"), request.POST.get("end")
    try:
        start_date, end_date = date.fromisoformat(start), date.fromisoformat(end)
    except (TypeError, ValueError):
        messages.error(request, "Choose a valid start and end date.")
        return redirect("audit")
    if start_date > end_date:
        messages.error(request, "The start date must not be after the end date.")
        return redirect("audit")
    deleted, _ = AuditLog.objects.filter(
        created_at__date__gte=start_date, created_at__date__lte=end_date
    ).delete()
    audit(
        request,
        "audit.clear",
        new_value={"start": start_date.isoformat(), "end": end_date.isoformat(), "deleted": deleted},
    )
    messages.success(request, f"Cleared {deleted} audit entries.")
    return redirect("audit")


class ChangePasswordView(PasswordChangeView):
    template_name = "inventory/action.html"
    success_url = reverse_lazy("dashboard")
    extra_context = {"title": "Change password", "back_url": "dashboard"}

    def form_valid(self, form):
        response = super().form_valid(form)
        update_session_auth_hash(self.request, self.request.user)
        messages.success(self.request, "Password changed.")
        return response
