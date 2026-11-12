from django.db import transaction
from rest_framework import serializers
from rest_framework.reverse import reverse

from .models import (
    CalendarPlan,
    Garment,
    Outfit,
    OutfitGarment,
    UserPreferences,
)


class CurrentUserGarmentField(serializers.PrimaryKeyRelatedField):
    def get_queryset(self):
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return Garment.objects.none()
        return Garment.objects.filter(owner=request.user)


class CurrentUserOutfitField(serializers.PrimaryKeyRelatedField):
    def get_queryset(self):
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return Outfit.objects.none()
        return Outfit.objects.filter(owner=request.user)


class PrivateGarmentImageField(serializers.ImageField):
    def to_representation(self, value):
        if not value:
            return None

        garment = value.instance
        if garment is None or garment.pk is None:
            return None

        return reverse(
            'closet:garment-image',
            kwargs={'pk': garment.pk},
            request=self.context.get('request'),
        )


class GarmentSerializer(serializers.ModelSerializer):
    image = PrivateGarmentImageField(
        required=False,
        validators=Garment._meta.get_field('image').validators,
    )

    class Meta:
        model = Garment
        fields = (
            'id',
            'owner',
            'name',
            'category',
            'subcategory',
            'color',
            'secondary_colors',
            'pattern',
            'season',
            'occasion',
            'material',
            'style',
            'description',
            'favorite',
            'is_archived',
            'image',
            'created_at',
            'updated_at',
        )
        read_only_fields = ('id', 'owner', 'created_at', 'updated_at')

    def validate_secondary_colors(self, value):
        if not isinstance(value, list) or not all(
            isinstance(color, str) for color in value
        ):
            raise serializers.ValidationError(
                'Must be a list of strings.'
            )
        return value


class OutfitGarmentSerializer(serializers.ModelSerializer):
    garment = CurrentUserGarmentField(queryset=Garment.objects.none())
    garment_details = GarmentSerializer(source='garment', read_only=True)

    class Meta:
        model = OutfitGarment
        fields = ('garment', 'garment_details', 'role', 'order')

class OutfitSerializer(serializers.ModelSerializer):
    garments = OutfitGarmentSerializer(
        source='outfit_garments',
        many=True,
        required=False,
    )

    class Meta:
        model = Outfit
        fields = (
            'id',
            'owner',
            'name',
            'occasion',
            'season',
            'garments',
            'created_at',
            'updated_at',
        )
        read_only_fields = ('id', 'owner', 'created_at', 'updated_at')

    def validate_garments(self, garments):
        garment_ids = [item['garment'].pk for item in garments]
        if len(garment_ids) != len(set(garment_ids)):
            raise serializers.ValidationError(
                'A garment can only appear once in an outfit.'
            )

        archived_garments = [
            item['garment']
            for item in garments
            if item['garment'].is_archived
        ]
        if archived_garments:
            existing_archived_ids = set()
            if self.instance is not None:
                existing_archived_ids = set(
                    self.instance.outfit_garments.filter(
                        garment__is_archived=True
                    ).values_list('garment_id', flat=True)
                )
            if any(
                garment.pk not in existing_archived_ids
                for garment in archived_garments
            ):
                raise serializers.ValidationError(
                    'Archived garments can only remain in existing outfits.'
                )
        return garments

    @transaction.atomic
    def create(self, validated_data):
        garment_links = validated_data.pop('outfit_garments', [])
        outfit = Outfit.objects.create(**validated_data)
        for link_data in garment_links:
            OutfitGarment.objects.create(outfit=outfit, **link_data)
        return outfit

    @transaction.atomic
    def update(self, instance, validated_data):
        garment_links = validated_data.pop('outfit_garments', None)
        instance = super().update(instance, validated_data)
        if garment_links is not None:
            instance.outfit_garments.filter(
                garment__is_archived=False
            ).delete()
            for link_data in garment_links:
                if link_data['garment'].is_archived:
                    continue
                OutfitGarment.objects.create(outfit=instance, **link_data)
        return instance


class CalendarPlanSerializer(serializers.ModelSerializer):
    outfit = CurrentUserOutfitField(queryset=Outfit.objects.none())

    class Meta:
        model = CalendarPlan
        fields = (
            'id',
            'owner',
            'date',
            'outfit',
            'created_at',
            'updated_at',
        )
        read_only_fields = ('id', 'owner', 'created_at', 'updated_at')

    def validate(self, attrs):
        attrs = super().validate(attrs)
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return attrs

        plan_date = attrs.get('date', getattr(self.instance, 'date', None))
        if plan_date is not None:
            existing_plans = CalendarPlan.objects.filter(
                owner=request.user,
                date=plan_date,
            )
            if self.instance is not None:
                existing_plans = existing_plans.exclude(pk=self.instance.pk)
            if existing_plans.exists():
                raise serializers.ValidationError({
                    'date': 'A calendar plan already exists for this date.'
                })
        return attrs


class UserPreferencesSerializer(serializers.ModelSerializer):
    style_preferences = serializers.JSONField(default=dict)
    color_preferences = serializers.JSONField(default=dict)

    class Meta:
        model = UserPreferences
        fields = (
            'id',
            'owner',
            'style_preferences',
            'color_preferences',
            'created_at',
            'updated_at',
        )
        read_only_fields = ('id', 'owner', 'created_at', 'updated_at')

    def validate_style_preferences(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('Must be a JSON object.')
        return value

    def validate_color_preferences(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('Must be a JSON object.')
        return value
