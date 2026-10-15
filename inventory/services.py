from collections import defaultdict
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from .models import (
    Branch,
    Dispatch,
    DispatchLine,
    IssueLine,
    Item,
    NumberSequence,
    OfficeIssue,
    PurchaseLine,
    RequestLine,
    StockLedger,
    StockRequest,
    SupplierPurchase,
    SystemSetting,
)


class WorkflowError(ValidationError):
    pass


@transaction.atomic
def next_number(prefix):
    counter, _ = NumberSequence.objects.get_or_create(key=prefix)
    counter = NumberSequence.objects.select_for_update().get(pk=counter.pk)
    counter.value += 1
    counter.save(update_fields=["value"])
    return f"{prefix}-{counter.value:04d}"


def main_branch():
    branch = Branch.objects.filter(kind=Branch.MAIN, active=True).first()
    if branch is None:
        raise WorkflowError("Set up the main office before recording stock activity.")
    return branch


def ensure_unique_items(lines):
    if len({row[0].pk for row in lines}) != len(lines):
        raise WorkflowError("Each item may appear only once; combine its quantities.")


def get_balance(item, branch, in_transit=False):
    return (
        StockLedger.objects.filter(item=item, branch=branch, in_transit=in_transit)
        .aggregate(total=Sum("quantity_change"))["total"]
        or 0
    )


def balances_for(branch=None, include_transit=False):
    rows = StockLedger.objects.values("item_id", "branch_id", "in_transit").annotate(
        quantity=Sum("quantity_change")
    )
    if branch is not None:
        rows = rows.filter(branch=branch)
    if not include_transit:
        rows = rows.filter(in_transit=False)
    result = defaultdict(int)
    for row in rows:
        key = (row["item_id"], row["branch_id"], row["in_transit"])
        result[key] = row["quantity"] or 0
    return result


def record_movement(
    *,
    item,
    branch,
    quantity,
    movement_type,
    user=None,
    in_transit=False,
    source=None,
    reason="",
    note="",
    reversal_of=None,
):
    return StockLedger.objects.create(
        item=item,
        branch=branch,
        in_transit=in_transit,
        quantity_change=quantity,
        movement_type=movement_type,
        source_type=source.__class__.__name__ if source else "",
        source_id=source.pk if source else None,
        reason=reason,
        note=note,
        reversal_of=reversal_of,
        created_by=user,
    )


def log_audit(user, action, record=None, old_value=None, new_value=None, ip_address=None):
    from .models import AuditLog

    if not SystemSetting.current().audit_logging_enabled:
        return None
    return AuditLog.objects.create(
        user=user if getattr(user, "is_authenticated", False) else None,
        action=action,
        record_type=record.__class__.__name__ if record else "",
        record_id=str(record.pk) if record else "",
        old_value=old_value,
        new_value=new_value,
        ip_address=ip_address,
    )


@transaction.atomic
def create_purchase(*, supplier, purchase_date, invoice_ref, notes, lines, user):
    if not lines:
        raise WorkflowError("Add at least one item to the purchase.")
    ensure_unique_items(lines)
    if not supplier.active:
        raise WorkflowError("Choose an active supplier.")
    purchase = SupplierPurchase.objects.create(
        number=next_number("PUR"),
        supplier=supplier,
        purchase_date=purchase_date,
        invoice_ref=invoice_ref,
        notes=notes,
        branch=main_branch(),
        created_by=user,
    )
    for item, quantity, unit_cost in lines:
        if not item.active:
            raise WorkflowError(f"{item} is inactive and cannot be purchased.")
        if quantity < 1 or not unit_cost.is_finite() or unit_cost < Decimal("0"):
            raise WorkflowError("Purchase quantities must be positive and costs cannot be negative.")
        PurchaseLine.objects.create(
            purchase=purchase,
            item=item,
            quantity_ordered=quantity,
            unit_cost=unit_cost,
        )
    log_audit(user, "purchase.create", purchase)
    return purchase


@transaction.atomic
def receive_purchase(*, purchase_id, quantities, user):
    purchase = SupplierPurchase.objects.select_for_update().get(pk=purchase_id)
    if purchase.status == SupplierPurchase.CANCELLED:
        raise WorkflowError("A cancelled purchase cannot be received.")
    if purchase.status == SupplierPurchase.RECEIVED:
        raise WorkflowError("This purchase has already been fully received.")
    main = purchase.branch or main_branch()
    received_any = False
    for line_id, quantity in quantities.items():
        line = PurchaseLine.objects.select_for_update().filter(
            pk=line_id, purchase=purchase
        ).select_related("item").first()
        if line is None:
            raise WorkflowError("A selected line does not belong to this purchase.")
        if quantity < 0 or quantity > line.outstanding:
            raise WorkflowError(f"Receipt quantity for {line.item} exceeds the outstanding amount.")
        if quantity == 0:
            continue
        received_any = True
        line.quantity_received += quantity
        line.save(update_fields=["quantity_received"])
        Item.objects.filter(pk=line.item_id).update(last_unit_cost=line.unit_cost)
        record_movement(
            item=line.item,
            branch=main,
            quantity=quantity,
            movement_type=StockLedger.PURCHASE,
            user=user,
            source=purchase,
            reason=f"Received {purchase.number}",
        )
    if not received_any:
        raise WorkflowError("Enter at least one positive quantity to receive.")
    remaining = PurchaseLine.objects.filter(
        purchase=purchase, quantity_received__lt=models_f("quantity_ordered")
    ).exists()
    purchase.status = (
        SupplierPurchase.PARTLY_RECEIVED if remaining else SupplierPurchase.RECEIVED
    )
    purchase.save(update_fields=["status"])
    log_audit(user, "purchase.receive", purchase, new_value={"received": True})
    return purchase


def models_f(field):
    from django.db.models import F

    return F(field)


@transaction.atomic
def cancel_purchase(*, purchase_id, user):
    purchase = SupplierPurchase.objects.select_for_update().get(pk=purchase_id)
    if purchase.status != SupplierPurchase.ORDERED:
        raise WorkflowError("A purchase can only be cancelled before any items are received.")
    purchase.status = SupplierPurchase.CANCELLED
    purchase.save(update_fields=["status"])
    log_audit(user, "purchase.cancel", purchase)
    return purchase


@transaction.atomic
def create_issue(*, recipient, department, issue_date, branch, purpose, lines, user):
    if not lines:
        raise WorkflowError("Add at least one item to the issue.")
    ensure_unique_items(lines)
    if not branch.active:
        raise WorkflowError("Choose an active location.")
    for item, quantity in lines:
        if not item.active:
            raise WorkflowError(f"{item} is inactive and cannot be issued.")
        if quantity < 1:
            raise WorkflowError("Issue quantities must be positive.")
        if get_balance(item, branch) < quantity:
            raise WorkflowError(f"Not enough {item} in stock.")
    issue = OfficeIssue.objects.create(
        number=next_number("ISS"),
        recipient=recipient,
        department=department,
        issue_date=issue_date,
        branch=branch,
        purpose=purpose,
        issued_by=user,
    )
    for item, quantity in lines:
        line = IssueLine.objects.create(issue=issue, item=item, quantity=quantity)
        record_movement(
            item=item,
            branch=branch,
            quantity=-quantity,
            movement_type=StockLedger.ISSUE,
            user=user,
            source=issue,
            reason=f"Issued to {recipient}",
        )
    log_audit(user, "issue.create", issue)
    return issue


@transaction.atomic
def cancel_issue(*, issue_id, reason, user):
    issue = OfficeIssue.objects.select_for_update().get(pk=issue_id)
    if issue.status == OfficeIssue.CANCELLED:
        raise WorkflowError("This issue has already been cancelled.")
    originals = list(
        StockLedger.objects.filter(
            source_type="OfficeIssue", source_id=issue.pk, movement_type=StockLedger.ISSUE
        )
    )
    issue.status = OfficeIssue.CANCELLED
    issue.cancelled_by = user
    issue.cancelled_at = timezone.now()
    issue.cancel_reason = reason
    issue.save(
        update_fields=["status", "cancelled_by", "cancelled_at", "cancel_reason"]
    )
    for original in originals:
        record_movement(
            item=original.item,
            branch=original.branch,
            quantity=-original.quantity_change,
            movement_type=StockLedger.ISSUE_REVERSAL,
            user=user,
            source=issue,
            reason=f"Cancellation of {issue.number}",
            reversal_of=original,
        )
    log_audit(user, "issue.cancel", issue, new_value={"reason": reason})
    return issue


@transaction.atomic
def create_request(*, branch, notes, lines, user):
    if not lines:
        raise WorkflowError("Add at least one item to the request.")
    ensure_unique_items(lines)
    if branch.kind != Branch.BRANCH or not branch.active:
        raise WorkflowError("Requests can only be created for an active branch.")
    request = StockRequest.objects.create(
        number=next_number("REQ"), branch=branch, notes=notes, requested_by=user
    )
    for item, quantity, reason in lines:
        if not item.active:
            raise WorkflowError(f"{item} is inactive and cannot be requested.")
        if quantity < 1:
            raise WorkflowError("Request quantities must be positive.")
        RequestLine.objects.create(
            request=request, item=item, quantity_requested=quantity, reason=reason
        )
    log_audit(user, "request.create", request)
    return request


@transaction.atomic
def review_request(*, request_id, decisions, user):
    request = StockRequest.objects.select_for_update().get(pk=request_id)
    if request.status != StockRequest.SUBMITTED:
        raise WorkflowError("Only submitted requests can be reviewed.")
    lines = {str(line.pk): line for line in request.lines.select_for_update()}
    if set(decisions) != set(lines):
        raise WorkflowError("Provide an approval decision for every request line.")
    approved_any = False
    rejected_any = False
    for line_id, (quantity, reason) in decisions.items():
        line = lines[line_id]
        if quantity < 0 or quantity > line.quantity_requested:
            raise WorkflowError("An approved quantity cannot exceed the requested quantity.")
        if quantity < line.quantity_requested and not reason.strip():
            raise WorkflowError("Give a reason for a reduced or rejected line.")
        line.quantity_approved = quantity
        line.reason = reason
        line.save(update_fields=["quantity_approved", "reason"])
        approved_any |= quantity > 0
        rejected_any |= quantity < line.quantity_requested
    request.status = (
        StockRequest.REJECTED
        if not approved_any
        else StockRequest.PARTLY_APPROVED
        if rejected_any
        else StockRequest.APPROVED
    )
    request.reviewed_by = user
    request.reviewed_at = timezone.now()
    request.save(update_fields=["status", "reviewed_by", "reviewed_at"])
    log_audit(user, "request.review", request, new_value={"status": request.status})
    return request


@transaction.atomic
def cancel_request(*, request_id, user):
    request = StockRequest.objects.select_for_update().get(pk=request_id)
    if request.status != StockRequest.SUBMITTED:
        raise WorkflowError("Only submitted requests can be cancelled.")
    request.status = StockRequest.CANCELLED
    request.save(update_fields=["status"])
    log_audit(user, "request.cancel", request)
    return request


@transaction.atomic
def create_dispatch(*, destination, request_obj, dispatch_date, lines, user):
    if not lines:
        raise WorkflowError("Add at least one item to the dispatch.")
    ensure_unique_items(lines)
    if destination.kind != Branch.BRANCH or not destination.active:
        raise WorkflowError("Choose an active destination branch.")
    main = main_branch()
    approved_lines = {}
    if request_obj:
        request_obj = StockRequest.objects.select_for_update().get(pk=request_obj.pk)
        if request_obj.branch_id != destination.pk or request_obj.status not in (
            StockRequest.APPROVED,
            StockRequest.PARTLY_APPROVED,
        ):
            raise WorkflowError("The request is not open for dispatch to this destination.")
        approved_lines = {
            line.item_id: line for line in request_obj.lines.select_for_update()
        }
    for item, quantity in lines:
        if not item.active:
            raise WorkflowError(f"{item} is inactive and cannot be dispatched.")
        if quantity < 1:
            raise WorkflowError("Dispatch quantities must be positive.")
        if get_balance(item, main) < quantity:
            raise WorkflowError(f"Not enough {item} at the main office.")
        if request_obj:
            request_line = approved_lines.get(item.pk)
            if request_line is None or quantity > request_line.outstanding:
                raise WorkflowError(f"Dispatch quantity for {item} exceeds the approved balance.")
    dispatch = Dispatch.objects.create(
        reference=next_number("DSP"),
        request=request_obj,
        destination=destination,
        dispatch_date=dispatch_date,
        dispatched_by=user,
    )
    for item, quantity in lines:
        DispatchLine.objects.create(dispatch=dispatch, item=item, quantity_sent=quantity)
        record_movement(
            item=item,
            branch=main,
            quantity=-quantity,
            movement_type=StockLedger.DISPATCH_OUT,
            user=user,
            source=dispatch,
            reason=f"Dispatch {dispatch.reference}",
        )
        record_movement(
            item=item,
            branch=None,
            in_transit=True,
            quantity=quantity,
            movement_type=StockLedger.TRANSIT_IN,
            user=user,
            source=dispatch,
            reason=f"Dispatch {dispatch.reference}",
        )
        if request_obj:
            request_line = approved_lines[item.pk]
            request_line.quantity_dispatched += quantity
            request_line.save(update_fields=["quantity_dispatched"])
    if request_obj and not request_obj.lines.filter(
        quantity_dispatched__lt=models_f("quantity_approved")
    ).exists():
        request_obj.status = StockRequest.COMPLETED
        request_obj.save(update_fields=["status"])
    log_audit(user, "dispatch.create", dispatch)
    return dispatch


@transaction.atomic
def receive_dispatch(*, dispatch_id, results, user):
    dispatch = Dispatch.objects.select_for_update().get(pk=dispatch_id)
    if dispatch.status != Dispatch.IN_TRANSIT:
        raise WorkflowError("This dispatch is no longer awaiting receipt.")
    if user.side == Branch.BRANCH and user.branch_id != dispatch.destination_id:
        raise WorkflowError("You can only receive dispatches sent to your branch.")
    lines = {str(line.pk): line for line in dispatch.lines.select_for_update()}
    if set(results) != set(lines):
        raise WorkflowError("Provide a receipt result for every dispatch line.")
    differences = False
    for line_id, (received, damaged) in results.items():
        line = lines[line_id]
        if received < 0 or damaged < 0 or received + damaged > line.quantity_sent:
            raise WorkflowError(f"Receipt quantities for {line.item} are invalid.")
        short = line.quantity_sent - received - damaged
        line.quantity_received = received
        line.quantity_damaged = damaged
        line.quantity_short = short
        line.save(update_fields=["quantity_received", "quantity_damaged", "quantity_short"])
        if received:
            record_movement(
                item=line.item,
                branch=None,
                in_transit=True,
                quantity=-received,
                movement_type=StockLedger.TRANSIT_OUT,
                user=user,
                source=dispatch,
                reason=f"Received for {dispatch.destination.name}",
            )
            record_movement(
                item=line.item,
                branch=dispatch.destination,
                quantity=received,
                movement_type=StockLedger.TRANSIT_OUT,
                user=user,
                source=dispatch,
                reason=f"Received from {dispatch.reference}",
            )
        differences |= damaged > 0 or short > 0
    dispatch.status = (
        Dispatch.RECEIVED_WITH_DIFFERENCES if differences else Dispatch.RECEIVED
    )
    dispatch.received_by = user
    dispatch.received_at = timezone.now()
    dispatch.save(update_fields=["status", "received_by", "received_at"])
    log_audit(user, "dispatch.receive", dispatch, new_value={"differences": differences})
    return dispatch


@transaction.atomic
def close_dispatch(*, dispatch_id, return_to_stock, user):
    dispatch = Dispatch.objects.select_for_update().get(pk=dispatch_id)
    if dispatch.status != Dispatch.RECEIVED_WITH_DIFFERENCES:
        raise WorkflowError("Only a dispatch with differences requires settlement.")
    main = main_branch()
    for line in dispatch.lines.select_for_update():
        unresolved = line.quantity_damaged + line.quantity_short
        if not unresolved:
            continue
        record_movement(
            item=line.item,
            branch=None,
            in_transit=True,
            quantity=-unresolved,
            movement_type=StockLedger.DISPATCH_RETURN,
            user=user,
            source=dispatch,
            reason="Transit difference settlement",
        )
        if return_to_stock:
            record_movement(
                item=line.item,
                branch=main,
                quantity=unresolved,
                movement_type=StockLedger.DISPATCH_RETURN,
                user=user,
                source=dispatch,
                reason="Returned during dispatch settlement",
            )
    dispatch.status = Dispatch.CLOSED
    dispatch.save(update_fields=["status"])
    log_audit(
        user,
        "dispatch.close",
        dispatch,
        new_value={"returned_to_stock": return_to_stock},
    )
    return dispatch


@transaction.atomic
def adjust_stock(*, item, branch, quantity, reason, note, user):
    if not quantity:
        raise WorkflowError("The correction quantity cannot be zero.")
    if not item.active or not branch.active:
        raise WorkflowError("Corrections require an active item and location.")
    if quantity < 0 and get_balance(item, branch) < abs(quantity):
        raise WorkflowError(f"Not enough {item} in stock for this correction.")
    movement = record_movement(
        item=item,
        branch=branch,
        quantity=quantity,
        movement_type=StockLedger.ADJUSTMENT,
        user=user,
        reason=reason,
        note=note,
    )
    log_audit(user, "stock.adjust", movement, new_value={"quantity": quantity})
    return movement
