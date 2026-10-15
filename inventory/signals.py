from django.db.models.signals import pre_delete, pre_save
from django.dispatch import receiver

from .models import StockLedger


@receiver(pre_save, sender=StockLedger)
def prevent_ledger_updates(sender, instance, **kwargs):
    if instance.pk and sender.objects.filter(pk=instance.pk).exists():
        raise ValueError("Stock ledger rows are append-only.")


@receiver(pre_delete, sender=StockLedger)
def prevent_ledger_deletes(sender, instance, **kwargs):
    raise ValueError("Stock ledger rows are append-only.")
