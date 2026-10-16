"""Records who did what. Never raises: an audit failure must not break the user's action."""
import logging

from django.db import transaction

from core.models import AuditLog, Setting

log = logging.getLogger(__name__)

_REDACT = {'password', 'new_password', 'current_password', 'token'}


def _clean(value):
    """Plain JSON-safe copy with anything secret removed."""
    if isinstance(value, dict):
        return {str(k): ('[hidden]' if str(k).lower() in _REDACT else _clean(v)) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_clean(v) for v in value]
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    return str(value)


def client_ip(request):
    if request is None:
        return ''
    return request.META.get('REMOTE_ADDR', '') or ''


def log_audit(request, action, record_type='', record_id='', old_value=None, new_value=None, force=False, actor=None):
    """`actor` names the user when nobody is signed in (e.g. an account locked out of signing in)."""
    try:
        if not force and not Setting.get().audit_logging_enabled:
            return
        user = actor or getattr(request, 'user', None)
        if user is not None and not getattr(user, 'pk', None):
            user = None
        with transaction.atomic():  # savepoint, so a failure cannot poison an outer transaction
            AuditLog.objects.create(
                user=user,
                action=action,
                record_type=record_type or '',
                record_id='' if record_id in (None, '') else str(record_id),
                old_value=_clean(old_value),
                new_value=_clean(new_value),
                ip=client_ip(request),
            )
    except Exception:  # noqa: BLE001 - by design
        log.exception('Audit log failed')
