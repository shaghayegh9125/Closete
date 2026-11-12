from django.core.exceptions import ValidationError
from django.db.models.signals import m2m_changed
from django.dispatch import receiver

from .models import Garment, Outfit


@receiver(m2m_changed, sender=Outfit.garments.through)
def validate_outfit_garment_ownership(sender, instance, action, pk_set, **kwargs):
    if action != 'pre_add' or not pk_set:
        return

    foreign_garments = Garment.objects.filter(pk__in=pk_set).exclude(
        owner_id=instance.owner_id
    )
    if foreign_garments.exists():
        raise ValidationError(
            'An outfit and its garments must belong to the same user.'
        )
