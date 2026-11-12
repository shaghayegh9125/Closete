import logging
from pathlib import PurePosixPath

from django.apps import apps
from django.db import DatabaseError, IntegrityError, transaction
from django.db.models import FileField
from django.db.models.deletion import ProtectedError
from django.http import FileResponse
from django.shortcuts import get_object_or_404
from PIL import Image, UnidentifiedImageError
from rest_framework.authentication import SessionAuthentication
from rest_framework.exceptions import ValidationError as APIValidationError
from rest_framework.generics import (
    ListCreateAPIView,
    RetrieveUpdateAPIView,
    RetrieveUpdateDestroyAPIView,
)
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.permissions import IsAuthenticated

from .models import CalendarPlan, Garment, Outfit, OutfitGarment, UserPreferences
from .serializers import (
    CalendarPlanSerializer,
    GarmentSerializer,
    OutfitSerializer,
    UserPreferencesSerializer,
)

logger = logging.getLogger(__name__)

GARMENT_IN_USE_MESSAGE = (
    'این لباس در یک یا چند استایل ذخیره‌شده استفاده شده است و امکان حذف '
    'دائمی آن وجود ندارد. می‌توانید آن را آرشیو کنید.'
)


def _delete_garment_image_if_unreferenced(storage, image_name, database):
    try:
        for model in apps.get_models():
            for field in model._meta.concrete_fields:
                if not isinstance(field, FileField):
                    continue
                if model._base_manager.using(database).filter(
                    **{field.name: image_name}
                ).exists():
                    return
        storage.delete(image_name)
    except Exception:
        logger.exception('Could not delete garment image %s.', image_name)

GARMENT_IMAGE_CONTENT_TYPES = {
    'JPEG': 'image/jpeg',
    'PNG': 'image/png',
    'WEBP': 'image/webp',
}


def _is_calendar_plan_date_conflict(error):
    database_error = error.__cause__ or error
    diagnostic = getattr(database_error, 'diag', None)
    if getattr(diagnostic, 'constraint_name', None) == (
        'unique_calendar_plan_per_owner_date'
    ):
        return True

    return (
        'UNIQUE constraint failed: '
        'closet_calendarplan.owner_id, closet_calendarplan.date'
        in str(database_error)
    )


def _save_calendar_plan(serializer, **kwargs):
    try:
        with transaction.atomic():
            return serializer.save(**kwargs)
    except IntegrityError as error:
        if not _is_calendar_plan_date_conflict(error):
            raise
        raise APIValidationError({
            'date': 'A calendar plan already exists for this date.'
        }) from error


class GarmentListCreateView(ListCreateAPIView):
    serializer_class = GarmentSerializer
    authentication_classes = (SessionAuthentication,)
    permission_classes = (IsAuthenticated,)

    def get_queryset(self):
        archived = self.request.query_params.get('archived')
        if archived is None or archived.lower() == 'false':
            is_archived = False
        elif archived.lower() == 'true':
            is_archived = True
        else:
            raise APIValidationError({
                'archived': 'Use "true" or "false".'
            })
        return Garment.objects.filter(
            owner=self.request.user,
            is_archived=is_archived,
        )

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)


class GarmentDetailView(RetrieveUpdateDestroyAPIView):
    serializer_class = GarmentSerializer
    authentication_classes = (SessionAuthentication,)
    permission_classes = (IsAuthenticated,)

    def get_queryset(self):
        queryset = Garment.objects.filter(owner=self.request.user)
        if self.request.method == 'DELETE':
            queryset = queryset.select_for_update()
        return queryset

    def destroy(self, request, *args, **kwargs):
        try:
            with transaction.atomic():
                garment = self.get_object()
                if OutfitGarment.objects.using(garment._state.db).filter(
                    garment_id=garment.pk
                ).exists():
                    return Response(
                        {'detail': GARMENT_IN_USE_MESSAGE},
                        status=409,
                    )

                image_name = garment.image.name
                storage = garment.image.storage if image_name else None
                database = garment._state.db
                garment.delete()

                if image_name:
                    transaction.on_commit(
                        lambda: _delete_garment_image_if_unreferenced(
                            storage,
                            image_name,
                            database,
                        ),
                        using=database,
                    )
        except ProtectedError:
            return Response(
                {'detail': GARMENT_IN_USE_MESSAGE},
                status=409,
            )
        except DatabaseError:
            logger.exception('Could not delete garment %s.', kwargs.get('pk'))
            return Response(
                {'detail': 'حذف لباس انجام نشد. لطفاً دوباره تلاش کنید.'},
                status=500,
            )

        return Response(status=204)


class GarmentImageView(APIView):
    authentication_classes = (SessionAuthentication,)
    permission_classes = (IsAuthenticated,)

    def get(self, request, pk):
        garment = get_object_or_404(
            Garment.objects.filter(owner=request.user),
            pk=pk,
        )
        if not garment.image or not garment.image.name:
            raise NotFound('Garment image not found.')

        storage = garment.image.storage
        image_name = garment.image.name
        image_path_parts = PurePosixPath(image_name).parts
        if (
            '\\' in image_name
            or len(image_path_parts) != 3
            or image_path_parts[:2] != ('closet', 'garments')
            or any(part in ('', '.', '..') for part in image_path_parts)
        ):
            raise NotFound('Garment image not found.')

        try:
            with storage.open(image_name, 'rb') as image_file:
                with Image.open(image_file) as image:
                    image_format = image.format
                    width, height = image.size
                    if (
                        image_format not in GARMENT_IMAGE_CONTENT_TYPES
                        or width > 6000
                        or height > 6000
                        or width * height > 25_000_000
                    ):
                        raise NotFound('Garment image not found.')
                    image.verify()
        except NotFound:
            raise
        except (
            EOFError,
            Image.DecompressionBombError,
            OSError,
            SyntaxError,
            UnidentifiedImageError,
            ValueError,
        ) as error:
            raise NotFound('Garment image not found.') from error

        try:
            image_file = storage.open(image_name, 'rb')
        except (FileNotFoundError, OSError) as error:
            raise NotFound('Garment image not found.') from error

        response = FileResponse(
            image_file,
            content_type=GARMENT_IMAGE_CONTENT_TYPES[image_format],
        )
        response['Cache-Control'] = 'private, no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        return response


class CurrentUserView(APIView):
    authentication_classes = (SessionAuthentication,)
    permission_classes = (IsAuthenticated,)

    def get(self, request):
        response = Response({'id': request.user.pk})
        response['Cache-Control'] = 'private, no-store'
        return response


class OutfitListCreateView(ListCreateAPIView):
    serializer_class = OutfitSerializer
    authentication_classes = (SessionAuthentication,)
    permission_classes = (IsAuthenticated,)

    def get_queryset(self):
        return Outfit.objects.filter(owner=self.request.user).prefetch_related(
            'outfit_garments__garment'
        )

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)


class OutfitDetailView(RetrieveUpdateDestroyAPIView):
    serializer_class = OutfitSerializer
    authentication_classes = (SessionAuthentication,)
    permission_classes = (IsAuthenticated,)

    def get_queryset(self):
        return Outfit.objects.filter(owner=self.request.user).prefetch_related(
            'outfit_garments__garment'
        )


class CalendarPlanListCreateView(ListCreateAPIView):
    serializer_class = CalendarPlanSerializer
    authentication_classes = (SessionAuthentication,)
    permission_classes = (IsAuthenticated,)

    def get_queryset(self):
        return CalendarPlan.objects.filter(
            owner=self.request.user
        ).select_related('outfit')

    def perform_create(self, serializer):
        _save_calendar_plan(serializer, owner=self.request.user)


class CalendarPlanDetailView(RetrieveUpdateDestroyAPIView):
    serializer_class = CalendarPlanSerializer
    authentication_classes = (SessionAuthentication,)
    permission_classes = (IsAuthenticated,)

    def get_queryset(self):
        return CalendarPlan.objects.filter(
            owner=self.request.user
        ).select_related('outfit')

    def perform_update(self, serializer):
        _save_calendar_plan(serializer)


class UserPreferencesView(RetrieveUpdateAPIView):
    serializer_class = UserPreferencesSerializer
    authentication_classes = (SessionAuthentication,)
    permission_classes = (IsAuthenticated,)

    def get_queryset(self):
        return UserPreferences.objects.filter(owner=self.request.user)

    def get_object(self):
        preferences, _ = UserPreferences.objects.get_or_create(
            owner=self.request.user
        )
        return preferences
