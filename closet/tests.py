from io import BytesIO
import tempfile
from types import ModuleType
from unittest import mock
from datetime import date
from pathlib import Path
import zlib

from django.contrib.auth import get_user_model
from django.conf import settings
from django.conf.urls.static import static
from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, transaction
from django.db.models.deletion import ProtectedError
from django.test import RequestFactory, TestCase, override_settings
from django.urls import resolve
from django.views.static import serve as static_serve
from PIL import Image as PillowImage
from rest_framework import status
from rest_framework.test import APIClient

from .models import CalendarPlan, Garment, Outfit, OutfitGarment, UserPreferences


def make_png(width, height):
    image = PillowImage.new('1', (width, height), 0)
    content = BytesIO()
    image.save(content, format='PNG')
    return content.getvalue()


def corrupt_png_pixel_data(content):
    chunks = []
    offset = 8
    while offset < len(content):
        length = int.from_bytes(content[offset:offset + 4], 'big')
        chunk_type = content[offset + 4:offset + 8]
        chunk_end = offset + 12 + length
        if chunk_type == b'IDAT':
            chunk_data = b'not-zlib-pixel-data'
            checksum = zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF
            chunks.append(
                len(chunk_data).to_bytes(4, 'big') +
                chunk_type + chunk_data + checksum.to_bytes(4, 'big')
            )
        else:
            chunks.append(content[offset:chunk_end])
        offset = chunk_end
    return content[:8] + b''.join(chunks)


class CurrentUserAPITests(TestCase):
    url = '/api/closet/me/'

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username='current-user-api',
            password='test-password',
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def test_authenticated_user_receives_own_id_without_cache(self):
        response = self.client.get(self.url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, {'id': self.user.pk})
        self.assertEqual(response['Cache-Control'], 'private, no-store')

    def test_anonymous_user_cannot_access_current_user_endpoint(self):
        self.client.force_authenticate(user=None)

        response = self.client.get(self.url)

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_get_does_not_create_database_records(self):
        user_model = get_user_model()
        before = {
            'users': user_model.objects.count(),
            'garments': Garment.objects.count(),
            'outfits': Outfit.objects.count(),
            'calendar_plans': CalendarPlan.objects.count(),
            'preferences': UserPreferences.objects.count(),
        }

        response = self.client.get(self.url)

        after = {
            'users': user_model.objects.count(),
            'garments': Garment.objects.count(),
            'outfits': Outfit.objects.count(),
            'calendar_plans': CalendarPlan.objects.count(),
            'preferences': UserPreferences.objects.count(),
        }
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(after, before)


class ClosetOwnershipTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.owner = user_model.objects.create_user(
            username='closet-owner',
            password='test-password',
        )
        self.other_user = user_model.objects.create_user(
            username='other-owner',
            password='test-password',
        )
        self.outfit = Outfit.objects.create(owner=self.owner, name='Everyday')
        self.garment = Garment.objects.create(
            owner=self.owner,
            name='White shirt',
            category='tops',
        )

    def test_same_owner_garment_can_be_added_to_outfit(self):
        self.outfit.garments.add(self.garment)

        self.assertTrue(
            OutfitGarment.objects.filter(
                outfit=self.outfit,
                garment=self.garment,
            ).exists()
        )

    def test_garment_owned_by_another_user_is_rejected_without_relation(self):
        foreign_garment = Garment.objects.create(
            owner=self.other_user,
            name='Other shirt',
            category='tops',
        )

        with self.assertRaises(ValidationError):
            with transaction.atomic():
                self.outfit.garments.add(foreign_garment)

        self.assertFalse(
            OutfitGarment.objects.filter(
                outfit=self.outfit,
                garment=foreign_garment,
            ).exists()
        )

    def test_calendar_plan_accepts_same_owner_outfit(self):
        plan = CalendarPlan.objects.create(
            owner=self.owner,
            date=date(2026, 10, 31),
            outfit=self.outfit,
        )

        self.assertEqual(plan.pk, CalendarPlan.objects.get(pk=plan.pk).pk)

    def test_calendar_plan_rejects_another_users_outfit(self):
        with self.assertRaises(ValidationError):
            CalendarPlan.objects.create(
                owner=self.other_user,
                date=date(2026, 10, 31),
                outfit=self.outfit,
            )

        self.assertFalse(
            CalendarPlan.objects.filter(
                owner=self.other_user,
                date=date(2026, 10, 31),
            ).exists()
        )


class GarmentImageValidationTests(TestCase):
    png_content = make_png(1, 1)

    def setUp(self):
        self.media_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.media_directory.cleanup)
        settings_override = override_settings(
            MEDIA_ROOT=self.media_directory.name,
        )
        settings_override.enable()
        self.addCleanup(settings_override.disable)
        self.owner = get_user_model().objects.create_user(
            username='image-owner',
            password='test-password',
        )

    def make_garment(self, filename, content):
        return Garment(
            owner=self.owner,
            name='Test garment',
            category='tops',
            image=SimpleUploadedFile(filename, content),
        )

    def test_existing_garment_can_be_created_without_new_attributes(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Legacy garment',
            category='tops',
        )

        garment.refresh_from_db()
        self.assertEqual(garment.subcategory, '')
        self.assertEqual(garment.secondary_colors, [])
        self.assertEqual(garment.pattern, '')
        self.assertEqual(garment.material, '')
        self.assertEqual(garment.style, '')
        self.assertEqual(garment.description, '')

    def test_secondary_colors_are_saved_as_a_list(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Colorful garment',
            category='tops',
            secondary_colors=['cream', 'olive'],
        )

        garment.refresh_from_db()
        self.assertEqual(garment.secondary_colors, ['cream', 'olive'])

    def test_invalid_secondary_colors_are_rejected(self):
        for value in ('cream', ['cream', 1], {'color': 'cream'}):
            with self.subTest(value=value):
                garment = Garment(
                    owner=self.owner,
                    name='Invalid colors',
                    category='tops',
                    secondary_colors=value,
                )

                with self.assertRaises(ValidationError) as context:
                    garment.full_clean()

                self.assertIn('secondary_colors', context.exception.message_dict)

    def test_image_with_disallowed_extension_is_rejected(self):
        garment = self.make_garment('image.gif', b'not an image')

        with self.assertRaises(ValidationError):
            garment.full_clean()

    def test_non_image_content_with_allowed_extension_is_rejected(self):
        garment = self.make_garment('image.jpg', b'not an image')

        with self.assertRaises(ValidationError):
            garment.full_clean()

    def test_image_larger_than_five_megabytes_is_rejected(self):
        content = b'x' * (5 * 1024 * 1024 + 1)
        garment = self.make_garment('large.png', content)

        with self.assertRaises(ValidationError):
            garment.full_clean()

    def test_image_over_maximum_side_length_is_rejected(self):
        garment = self.make_garment(
            'wide.png',
            make_png(6001, 1),
        )

        with self.assertRaises(ValidationError):
            garment.full_clean()

    def test_image_over_maximum_pixel_count_is_rejected(self):
        garment = self.make_garment(
            'large-dimensions.png',
            make_png(5001, 5000),
        )

        with self.assertRaises(ValidationError):
            garment.full_clean()

    def test_small_allowed_image_is_accepted_and_stored_temporarily(self):
        garment = self.make_garment('small.png', self.png_content)

        garment.full_clean()
        garment.save()

        stored_path = Path(garment.image.path)
        self.assertTrue(stored_path.is_file())
        self.assertTrue(stored_path.is_relative_to(Path(self.media_directory.name)))


class GarmentAPITests(TestCase):
    list_url = '/api/closet/garments/'

    png_content = make_png(1, 1)

    def setUp(self):
        self.media_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.media_directory.cleanup)
        settings_override = override_settings(
            MEDIA_ROOT=self.media_directory.name,
        )
        settings_override.enable()
        self.addCleanup(settings_override.disable)
        user_model = get_user_model()
        self.owner = user_model.objects.create_user(
            username='api-owner',
            password='test-password',
        )
        self.other_user = user_model.objects.create_user(
            username='api-other',
            password='test-password',
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.owner)
        self.own_garment = Garment.objects.create(
            owner=self.owner,
            name='My shirt',
            category='tops',
        )
        self.foreign_garment = Garment.objects.create(
            owner=self.other_user,
            name='Other shirt',
            category='tops',
        )

    def garment_payload(self, **overrides):
        payload = {
            'name': 'New shirt',
            'category': 'tops',
            'color': 'white',
            'season': 'summer',
            'occasion': 'daily',
            'favorite': False,
        }
        payload.update(overrides)
        return payload

    def media_files(self):
        return {
            path
            for path in Path(self.media_directory.name).rglob('*')
            if path.is_file()
        }

    def assert_invalid_image_upload(self, filename, content, content_type):
        garment_count = Garment.objects.count()
        media_files_before = self.media_files()
        response = self.client.post(
            self.list_url,
            self.garment_payload(
                image=SimpleUploadedFile(
                    filename,
                    content,
                    content_type=content_type,
                )
            ),
            format='multipart',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('image', response.data)
        self.assertEqual(Garment.objects.count(), garment_count)
        self.assertEqual(self.media_files(), media_files_before)

    def test_list_only_returns_current_users_garments(self):
        response = self.client.get(self.list_url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item['id'] for item in response.data], [self.own_garment.pk])

    def test_create_assigns_current_user_and_ignores_client_owner(self):
        response = self.client.post(
            self.list_url,
            self.garment_payload(owner=self.other_user.pk),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        garment = Garment.objects.get(pk=response.data['id'])
        self.assertEqual(garment.owner, self.owner)
        self.assertEqual(response.data['owner'], self.owner.pk)

    def test_create_and_retrieve_include_new_garment_attributes(self):
        attributes = {
            'subcategory': 'button-down',
            'secondary_colors': ['cream', 'olive'],
            'pattern': 'striped',
            'material': 'cotton',
            'style': 'casual',
            'description': 'Lightweight summer shirt.',
        }
        response = self.client.post(
            self.list_url,
            self.garment_payload(**attributes),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        for field, value in attributes.items():
            with self.subTest(field=field):
                self.assertEqual(response.data[field], value)

        detail_response = self.client.get(
            f'{self.list_url}{response.data["id"]}/'
        )
        self.assertEqual(detail_response.status_code, status.HTTP_200_OK)
        for field, value in attributes.items():
            with self.subTest(field=field):
                self.assertEqual(detail_response.data[field], value)

    def test_api_rejects_non_list_secondary_colors(self):
        for value in ('cream', ['cream', 1], {'color': 'cream'}):
            with self.subTest(value=value):
                response = self.client.post(
                    self.list_url,
                    self.garment_payload(secondary_colors=value),
                    format='json',
                )

                self.assertEqual(
                    response.status_code,
                    status.HTTP_400_BAD_REQUEST,
                )
                self.assertIn('secondary_colors', response.data)

    def test_owner_can_retrieve_update_and_delete_garment_without_image(self):
        detail_url = f'{self.list_url}{self.own_garment.pk}/'

        get_response = self.client.get(detail_url)
        self.assertEqual(get_response.status_code, status.HTTP_200_OK)

        patch_response = self.client.patch(
            detail_url,
            {'name': 'Updated shirt'},
            format='json',
        )
        self.assertEqual(patch_response.status_code, status.HTTP_200_OK)
        self.own_garment.refresh_from_db()
        self.assertEqual(self.own_garment.name, 'Updated shirt')

        delete_response = self.client.delete(detail_url)
        self.assertEqual(delete_response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Garment.objects.filter(pk=self.own_garment.pk).exists())

    def test_delete_garment_used_by_one_outfit_returns_conflict(self):
        outfit = Outfit.objects.create(owner=self.owner, name='Saved outfit')
        link = OutfitGarment.objects.create(
            outfit=outfit,
            garment=self.own_garment,
        )

        response = self.client.delete(f'{self.list_url}{self.own_garment.pk}/')

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertIn('استایل ذخیره‌شده', response.data['detail'])
        self.assertTrue(Garment.objects.filter(pk=self.own_garment.pk).exists())
        self.assertTrue(Outfit.objects.filter(pk=outfit.pk).exists())
        self.assertTrue(OutfitGarment.objects.filter(pk=link.pk).exists())

    def test_delete_garment_used_by_multiple_outfits_returns_conflict(self):
        first_outfit = Outfit.objects.create(owner=self.owner, name='First outfit')
        second_outfit = Outfit.objects.create(owner=self.owner, name='Second outfit')
        OutfitGarment.objects.create(outfit=first_outfit, garment=self.own_garment)
        OutfitGarment.objects.create(outfit=second_outfit, garment=self.own_garment)

        response = self.client.delete(f'{self.list_url}{self.own_garment.pk}/')

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertTrue(Garment.objects.filter(pk=self.own_garment.pk).exists())
        self.assertEqual(
            OutfitGarment.objects.filter(garment=self.own_garment).count(),
            2,
        )

    def test_protected_error_during_delete_returns_conflict(self):
        with mock.patch.object(
            Garment,
            'delete',
            side_effect=ProtectedError('protected', [self.own_garment]),
        ):
            response = self.client.delete(
                f'{self.list_url}{self.own_garment.pk}/'
            )

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertTrue(Garment.objects.filter(pk=self.own_garment.pk).exists())

    def test_delete_archived_garment_used_by_outfit_returns_conflict(self):
        self.own_garment.is_archived = True
        self.own_garment.save(update_fields=['is_archived'])
        outfit = Outfit.objects.create(owner=self.owner, name='Historical outfit')
        link = OutfitGarment.objects.create(
            outfit=outfit,
            garment=self.own_garment,
        )

        response = self.client.delete(f'{self.list_url}{self.own_garment.pk}/')

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.own_garment.refresh_from_db()
        self.assertTrue(self.own_garment.is_archived)
        self.assertTrue(OutfitGarment.objects.filter(pk=link.pk).exists())

    def test_delete_archived_garment_without_outfit_succeeds(self):
        self.own_garment.is_archived = True
        self.own_garment.save(update_fields=['is_archived'])

        response = self.client.delete(f'{self.list_url}{self.own_garment.pk}/')

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Garment.objects.filter(pk=self.own_garment.pk).exists())

    def test_blocked_garment_delete_preserves_calendar_plan(self):
        outfit = Outfit.objects.create(owner=self.owner, name='Planned outfit')
        link = OutfitGarment.objects.create(
            outfit=outfit,
            garment=self.own_garment,
        )
        plan = CalendarPlan.objects.create(
            owner=self.owner,
            date=date(2026, 11, 1),
            outfit=outfit,
        )

        response = self.client.delete(f'{self.list_url}{self.own_garment.pk}/')

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertTrue(Garment.objects.filter(pk=self.own_garment.pk).exists())
        self.assertTrue(Outfit.objects.filter(pk=outfit.pk).exists())
        self.assertTrue(OutfitGarment.objects.filter(pk=link.pk).exists())
        self.assertTrue(CalendarPlan.objects.filter(pk=plan.pk).exists())

    def test_delete_garment_deletes_image_after_commit(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Image shirt',
            category='tops',
            image=SimpleUploadedFile('delete-me.png', self.png_content),
        )
        image_path = Path(garment.image.path)
        self.assertTrue(image_path.is_file())

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.delete(f'{self.list_url}{garment.pk}/')

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Garment.objects.filter(pk=garment.pk).exists())
        self.assertFalse(image_path.exists())

    def test_delete_garment_with_shared_image_keeps_file(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Shared image shirt',
            category='tops',
            image=SimpleUploadedFile('shared.png', self.png_content),
        )
        image_name = garment.image.name
        shared_garment = Garment.objects.create(
            owner=self.owner,
            name='Second shared image shirt',
            category='tops',
            image=image_name,
        )
        image_path = Path(garment.image.path)

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.delete(f'{self.list_url}{garment.pk}/')

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertTrue(Garment.objects.filter(pk=shared_garment.pk).exists())
        self.assertTrue(image_path.is_file())

    def test_image_storage_failure_does_not_restore_deleted_garment(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Storage failure shirt',
            category='tops',
            image=SimpleUploadedFile('storage-failure.png', self.png_content),
        )
        storage = garment.image.storage
        image_name = garment.image.name

        with mock.patch.object(
            storage,
            'delete',
            side_effect=OSError('simulated storage failure'),
        ) as delete_file:
            with self.captureOnCommitCallbacks(execute=True):
                response = self.client.delete(f'{self.list_url}{garment.pk}/')

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Garment.objects.filter(pk=garment.pk).exists())
        delete_file.assert_called_once_with(image_name)

    def test_repeated_garment_delete_returns_not_found(self):
        detail_url = f'{self.list_url}{self.own_garment.pk}/'

        first_response = self.client.delete(detail_url)
        second_response = self.client.delete(detail_url)

        self.assertEqual(first_response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(second_response.status_code, status.HTTP_404_NOT_FOUND)

    def test_patch_updates_name_and_category_without_creating_garment(self):
        garment_count = Garment.objects.count()
        response = self.client.patch(
            f'{self.list_url}{self.own_garment.pk}/',
            {'name': 'Updated shirt', 'category': 'dresses'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.own_garment.refresh_from_db()
        self.assertEqual(self.own_garment.name, 'Updated shirt')
        self.assertEqual(self.own_garment.category, 'dresses')
        self.assertEqual(Garment.objects.count(), garment_count)

    def test_patch_updates_colors_and_other_garment_attributes(self):
        attributes = {
            'color': 'cream',
            'secondary_colors': ['olive', 'black'],
            'pattern': 'striped',
            'material': 'cotton',
            'style': 'casual',
            'description': 'Lightweight shirt.',
        }
        response = self.client.patch(
            f'{self.list_url}{self.own_garment.pk}/',
            attributes,
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.own_garment.refresh_from_db()
        for field, value in attributes.items():
            with self.subTest(field=field):
                self.assertEqual(getattr(self.own_garment, field), value)

    def test_patch_replaces_garment_image(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Image shirt',
            category='tops',
            image=SimpleUploadedFile('original.png', self.png_content),
        )
        original_image_name = garment.image.name
        replacement_content = make_png(2, 2)

        response = self.client.patch(
            f'{self.list_url}{garment.pk}/',
            {
                'image': SimpleUploadedFile(
                    'replacement.png',
                    replacement_content,
                ),
            },
            format='multipart',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        garment.refresh_from_db()
        self.assertNotEqual(garment.image.name, original_image_name)
        with garment.image.open('rb') as image_file:
            self.assertEqual(image_file.read(), replacement_content)

    def test_patch_rejects_invalid_image_and_preserves_existing_image(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Image shirt',
            category='tops',
            image=SimpleUploadedFile('original.png', self.png_content),
        )
        original_image_name = garment.image.name

        response = self.client.patch(
            f'{self.list_url}{garment.pk}/',
            {
                'image': SimpleUploadedFile(
                    'replacement.gif',
                    b'not a valid image',
                ),
            },
            format='multipart',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('image', response.data)
        garment.refresh_from_db()
        self.assertEqual(garment.image.name, original_image_name)
        with garment.image.open('rb') as image_file:
            self.assertEqual(image_file.read(), self.png_content)

    def test_patch_rejects_allowed_extension_text_and_keeps_old_image_and_metadata(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Image shirt',
            category='tops',
            image=SimpleUploadedFile('original.png', self.png_content),
        )
        original_image_name = garment.image.name
        original_files = self.media_files()
        garment_count = Garment.objects.count()

        response = self.client.patch(
            f'{self.list_url}{garment.pk}/',
            {
                'name': 'Should not be saved',
                'image': SimpleUploadedFile(
                    'fake-image.png',
                    b'not an image',
                    content_type='image/png',
                ),
            },
            format='multipart',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('image', response.data)
        garment.refresh_from_db()
        self.assertEqual(garment.name, 'Image shirt')
        self.assertEqual(garment.image.name, original_image_name)
        self.assertEqual(Garment.objects.count(), garment_count)
        self.assertEqual(self.media_files(), original_files)
        with garment.image.open('rb') as image_file:
            self.assertEqual(image_file.read(), self.png_content)

    def test_patch_rejects_corrupt_pixel_data_and_preserves_existing_image(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Image shirt',
            category='tops',
            image=SimpleUploadedFile('original.png', self.png_content),
        )
        original_image_name = garment.image.name
        original_files = self.media_files()
        garment_count = Garment.objects.count()

        response = self.client.patch(
            f'{self.list_url}{garment.pk}/',
            {
                'name': 'Should not be saved',
                'image': SimpleUploadedFile(
                    'corrupt-pixels.png',
                    corrupt_png_pixel_data(self.png_content),
                    content_type='image/png',
                ),
            },
            format='multipart',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('image', response.data)
        garment.refresh_from_db()
        self.assertEqual(garment.name, 'Image shirt')
        self.assertEqual(garment.image.name, original_image_name)
        self.assertEqual(Garment.objects.count(), garment_count)
        self.assertEqual(self.media_files(), original_files)
        with garment.image.open('rb') as image_file:
            self.assertEqual(image_file.read(), self.png_content)

    def test_patch_without_new_image_preserves_existing_image(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Image shirt',
            category='tops',
            image=SimpleUploadedFile('original.png', self.png_content),
        )
        original_image_name = garment.image.name

        response = self.client.patch(
            f'{self.list_url}{garment.pk}/',
            {'name': 'Updated image shirt'},
            format='multipart',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        garment.refresh_from_db()
        self.assertEqual(garment.name, 'Updated image shirt')
        self.assertEqual(garment.image.name, original_image_name)
        with garment.image.open('rb') as image_file:
            self.assertEqual(image_file.read(), self.png_content)

    def test_archived_garment_can_be_updated_without_being_unarchived(self):
        self.own_garment.is_archived = True
        self.own_garment.save(update_fields=['is_archived'])

        response = self.client.patch(
            f'{self.list_url}{self.own_garment.pk}/',
            {'name': 'Updated archived shirt', 'category': 'outerwear'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.own_garment.refresh_from_db()
        self.assertEqual(self.own_garment.name, 'Updated archived shirt')
        self.assertEqual(self.own_garment.category, 'outerwear')
        self.assertTrue(self.own_garment.is_archived)

    def test_other_user_cannot_retrieve_update_or_delete_garment(self):
        self.client.force_authenticate(user=self.other_user)
        detail_url = f'{self.list_url}{self.own_garment.pk}/'

        self.assertEqual(
            self.client.get(detail_url).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            self.client.patch(
                detail_url,
                {'name': 'Stolen update'},
                format='json',
            ).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            self.client.delete(detail_url).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.own_garment.refresh_from_db()
        self.assertEqual(self.own_garment.name, 'My shirt')

    def test_archive_garment_preserves_record_and_outfit_relation(self):
        outfit = Outfit.objects.create(owner=self.owner, name='Saved outfit')
        link = OutfitGarment.objects.create(
            outfit=outfit,
            garment=self.own_garment,
            role='top',
            order=1,
        )

        response = self.client.patch(
            f'{self.list_url}{self.own_garment.pk}/',
            {'is_archived': True},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.own_garment.refresh_from_db()
        self.assertTrue(self.own_garment.is_archived)
        self.assertTrue(Garment.objects.filter(pk=self.own_garment.pk).exists())
        self.assertTrue(OutfitGarment.objects.filter(pk=link.pk).exists())

    def test_archived_garment_can_be_restored(self):
        self.own_garment.is_archived = True
        self.own_garment.save()

        response = self.client.patch(
            f'{self.list_url}{self.own_garment.pk}/',
            {'is_archived': False},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.own_garment.refresh_from_db()
        self.assertFalse(self.own_garment.is_archived)

    def test_restoring_archived_garment_preserves_existing_outfit_relation(self):
        outfit = Outfit.objects.create(owner=self.owner, name='Saved outfit')
        link = OutfitGarment.objects.create(
            outfit=outfit,
            garment=self.own_garment,
            role='top',
            order=1,
        )
        self.own_garment.is_archived = True
        self.own_garment.save()

        response = self.client.patch(
            f'{self.list_url}{self.own_garment.pk}/',
            {'is_archived': False},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.own_garment.refresh_from_db()
        self.assertFalse(self.own_garment.is_archived)
        self.assertTrue(OutfitGarment.objects.filter(pk=link.pk).exists())
        self.assertTrue(
            Outfit.objects.get(pk=outfit.pk).garments.filter(
                pk=self.own_garment.pk
            ).exists()
        )

    def test_garment_lists_default_to_active_and_can_list_archived(self):
        self.own_garment.is_archived = True
        self.own_garment.save()
        self.foreign_garment.is_archived = True
        self.foreign_garment.save()

        active_response = self.client.get(self.list_url)
        archived_response = self.client.get(
            self.list_url,
            {'archived': 'true'},
        )

        self.assertEqual(active_response.status_code, status.HTTP_200_OK)
        self.assertEqual(active_response.data, [])
        self.assertEqual(archived_response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [item['id'] for item in archived_response.data],
            [self.own_garment.pk],
        )

    def test_garment_list_rejects_invalid_archived_filter(self):
        response = self.client.get(self.list_url, {'archived': 'yes'})

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('archived', response.data)

    def test_other_user_cannot_archive_or_restore_garment(self):
        detail_url = f'{self.list_url}{self.own_garment.pk}/'
        self.client.force_authenticate(user=self.other_user)

        archive_response = self.client.patch(
            detail_url,
            {'is_archived': True},
            format='json',
        )
        self.assertEqual(archive_response.status_code, status.HTTP_404_NOT_FOUND)

        self.own_garment.is_archived = True
        self.own_garment.save()
        restore_response = self.client.patch(
            detail_url,
            {'is_archived': False},
            format='json',
        )

        self.assertEqual(restore_response.status_code, status.HTTP_404_NOT_FOUND)
        self.own_garment.refresh_from_db()
        self.assertTrue(self.own_garment.is_archived)

    def test_archive_patch_requires_valid_csrf(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.login(username='api-owner', password='test-password')

        response = csrf_client.patch(
            f'{self.list_url}{self.own_garment.pk}/',
            {'is_archived': True},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.own_garment.refresh_from_db()
        self.assertFalse(self.own_garment.is_archived)

    def test_archive_patch_rejects_invalid_csrf_token(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.login(username='api-owner', password='test-password')
        csrf_client.cookies['csrftoken'] = 'a' * 32

        response = csrf_client.patch(
            f'{self.list_url}{self.own_garment.pk}/',
            {'is_archived': True},
            format='json',
            HTTP_X_CSRFTOKEN='b' * 32,
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.own_garment.refresh_from_db()
        self.assertFalse(self.own_garment.is_archived)

    def test_archive_patch_accepts_matching_csrf_token(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.login(username='api-owner', password='test-password')
        csrf_client.cookies['csrftoken'] = 'a' * 32

        response = csrf_client.patch(
            f'{self.list_url}{self.own_garment.pk}/',
            {'is_archived': True},
            format='json',
            HTTP_X_CSRFTOKEN='a' * 32,
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.own_garment.refresh_from_db()
        self.assertTrue(self.own_garment.is_archived)

    def test_anonymous_requests_are_rejected(self):
        self.client.force_authenticate(user=None)

        self.assertEqual(
            self.client.get(self.list_url).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(
            self.client.post(
                self.list_url,
                self.garment_payload(),
                format='json',
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )

    def test_invalid_image_extension_is_rejected(self):
        self.assert_invalid_image_upload(
            'image.gif',
            b'not an image',
            'image/gif',
        )

    def test_text_file_named_png_and_claiming_png_mime_is_rejected(self):
        self.assert_invalid_image_upload(
            'fake-image.png',
            b'this is not an image',
            'image/png',
        )

    def test_image_content_must_match_allowed_extension(self):
        self.assert_invalid_image_upload(
            'valid-png.jpg',
            self.png_content,
            'image/jpeg',
        )

    def test_corrupted_image_with_allowed_extension_is_rejected(self):
        self.assert_invalid_image_upload(
            'corrupted.png',
            b'\x89PNG\r\n\x1a\nincomplete image data',
            'image/png',
        )

    def test_corrupt_png_pixel_data_is_rejected(self):
        self.assert_invalid_image_upload(
            'corrupt-pixels.png',
            corrupt_png_pixel_data(self.png_content),
            'image/png',
        )

    def test_image_larger_than_five_megabytes_is_rejected(self):
        oversized_png = self.png_content + b'\x00' * (
            5 * 1024 * 1024 + 1 - len(self.png_content)
        )
        self.assert_invalid_image_upload(
            'large.png',
            oversized_png,
            'image/png',
        )

    def test_image_over_maximum_side_length_is_rejected(self):
        self.assert_invalid_image_upload(
            'too-wide.png',
            make_png(6001, 1),
            'image/png',
        )

    def test_image_over_maximum_pixel_count_is_rejected(self):
        self.assert_invalid_image_upload(
            'too-many-pixels.png',
            make_png(5001, 5000),
            'image/png',
        )

    def test_valid_jpeg_and_webp_images_are_accepted(self):
        for image_format, extension, content_type in (
            ('JPEG', 'jpg', 'image/jpeg'),
            ('WEBP', 'webp', 'image/webp'),
        ):
            with self.subTest(image_format=image_format):
                image = PillowImage.new('RGB', (2, 2), (20, 40, 60))
                content = BytesIO()
                image.save(content, format=image_format)
                response = self.client.post(
                    self.list_url,
                    self.garment_payload(
                        image=SimpleUploadedFile(
                            f'valid.{extension}',
                            content.getvalue(),
                            content_type=content_type,
                        )
                    ),
                    format='multipart',
                )

                self.assertEqual(
                    response.status_code,
                    status.HTTP_201_CREATED,
                )
                self.assertTrue(
                    Garment.objects.get(pk=response.data['id']).image
                )

    def test_valid_png_with_misleading_mime_uses_detected_content_type(self):
        response = self.client.post(
            self.list_url,
            self.garment_payload(
                image=SimpleUploadedFile(
                    'valid.png',
                    self.png_content,
                    content_type='text/plain',
                )
            ),
            format='multipart',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        image_response = self.client.get(response.data['image'])
        self.assertEqual(image_response.status_code, status.HTTP_200_OK)
        self.assertEqual(image_response['Content-Type'], 'image/png')
        self.assertEqual(
            b''.join(image_response.streaming_content),
            self.png_content,
        )

    def test_garment_without_image_is_still_accepted(self):
        response = self.client.post(
            self.list_url,
            self.garment_payload(),
            format='multipart',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertIsNone(response.data['image'])

    def test_small_allowed_image_is_accepted(self):
        response = self.client.post(
            self.list_url,
            self.garment_payload(
                subcategory='button-down',
                secondary_colors='["cream", "olive"]',
                pattern='striped',
                material='cotton',
                style='casual',
                description='A light shirt.',
                image=SimpleUploadedFile('small.png', self.png_content),
            ),
            format='multipart',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        garment = Garment.objects.get(pk=response.data['id'])
        self.assertTrue(garment.image)
        self.assertEqual(response.data['subcategory'], 'button-down')
        self.assertEqual(response.data['secondary_colors'], ['cream', 'olive'])
        self.assertEqual(response.data['pattern'], 'striped')
        self.assertEqual(response.data['material'], 'cotton')
        self.assertEqual(response.data['style'], 'casual')
        self.assertEqual(response.data['description'], 'A light shirt.')
        image_url = response.data['image']
        self.assertTrue(
            image_url.endswith(
                f'/api/closet/garments/{garment.pk}/image/'
            )
        )

        image_response = self.client.get(image_url)
        self.assertEqual(image_response.status_code, status.HTTP_200_OK)
        self.assertEqual(image_response['Content-Type'], 'image/png')
        self.assertEqual(
            b''.join(image_response.streaming_content),
            self.png_content,
        )

    def test_owner_can_fetch_own_garment_image(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Image shirt',
            category='tops',
            image=SimpleUploadedFile('shirt.png', self.png_content),
        )

        response = self.client.get(
            f'{self.list_url}{garment.pk}/image/'
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response['Content-Type'], 'image/png')
        self.assertEqual(response['Cache-Control'], 'private, no-store')
        self.assertEqual(response['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(
            b''.join(response.streaming_content),
            self.png_content,
        )

    def test_owner_endpoint_can_serve_an_existing_stored_garment_image(self):
        stored_image_name = self.own_garment.image.storage.save(
            'closet/garments/existing.png',
            ContentFile(self.png_content),
        )
        self.own_garment.image.name = stored_image_name
        self.own_garment.save(update_fields=['image'])

        response = self.client.get(
            f'{self.list_url}{self.own_garment.pk}/image/'
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            b''.join(response.streaming_content),
            self.png_content,
        )

    def test_other_user_cannot_fetch_garment_image(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Private shirt',
            category='tops',
            image=SimpleUploadedFile('private.png', self.png_content),
        )
        self.client.force_authenticate(user=self.other_user)

        response = self.client.get(
            f'{self.list_url}{garment.pk}/image/'
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_anonymous_user_cannot_fetch_garment_image(self):
        self.client.force_authenticate(user=None)

        response = self.client.get(
            f'{self.list_url}{self.own_garment.pk}/image/'
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_missing_garment_image_returns_not_found(self):
        response = self.client.get(
            f'{self.list_url}{self.own_garment.pk}/image/'
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_missing_stored_image_returns_not_found(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Missing file shirt',
            category='tops',
            image='closet/garments/missing.png',
        )

        response = self.client.get(
            f'{self.list_url}{garment.pk}/image/'
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_unknown_garment_image_returns_not_found(self):
        response = self.client.get(
            f'{self.list_url}999999/image/'
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_invalid_stored_image_path_is_not_opened(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Invalid path shirt',
            category='tops',
            image='closet/garments/../private.png',
        )

        response = self.client.get(
            f'{self.list_url}{garment.pk}/image/'
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_invalid_image_route_and_public_media_path_do_not_serve_files(self):
        garment = Garment.objects.create(
            owner=self.owner,
            name='Private shirt',
            category='tops',
            image=SimpleUploadedFile('private.png', self.png_content),
        )

        invalid_id_response = self.client.get(
            f'{self.list_url}not-an-id/image/'
        )
        public_media_client = APIClient()
        public_media_response = public_media_client.get(garment.image.url)

        self.assertEqual(
            invalid_id_response.status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            public_media_response.status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_public_product_media_remains_available(self):
        product_image_directory = (
            Path(self.media_directory.name)
            / 'product'
            / 'product_cover'
        )
        product_image_directory.mkdir(parents=True, exist_ok=True)
        product_image = product_image_directory / 'store-product.png'
        product_image.write_bytes(self.png_content)

        import config.urls

        product_media_url = '/media/product/product_cover/store-product.png'
        with override_settings(
            DEBUG=True,
            MEDIA_ROOT=self.media_directory.name,
        ):
            test_urlconf = ModuleType('closet.tests_media_urlconf')
            test_urlconf.urlpatterns = [
                pattern
                for pattern in config.urls.urlpatterns
                if getattr(pattern, 'callback', None) is not static_serve
            ] + static(
                settings.MEDIA_URL,
                document_root=settings.MEDIA_ROOT,
            )
            resolved_route = resolve(
                product_media_url,
                urlconf=test_urlconf,
            )
            self.assertIs(resolved_route.func, static_serve)
            response = resolved_route.func(
                RequestFactory().get(product_media_url),
                **resolved_route.kwargs,
            )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response['Content-Type'], 'image/png')
        self.assertEqual(
            b''.join(response.streaming_content),
            self.png_content,
        )

    def test_session_authentication_enforces_csrf_for_unsafe_requests(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.login(username='api-owner', password='test-password')

        response = csrf_client.post(
            self.list_url,
            self.garment_payload(),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)


class OutfitAPITests(TestCase):
    list_url = '/api/closet/outfits/'

    def setUp(self):
        user_model = get_user_model()
        self.owner = user_model.objects.create_user(
            username='outfit-owner',
            password='test-password',
        )
        self.other_user = user_model.objects.create_user(
            username='outfit-other',
            password='test-password',
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.owner)
        self.own_garment = Garment.objects.create(
            owner=self.owner,
            name='Owner shirt',
            category='tops',
        )
        self.second_garment = Garment.objects.create(
            owner=self.owner,
            name='Owner trousers',
            category='trousers',
        )
        self.foreign_garment = Garment.objects.create(
            owner=self.other_user,
            name='Foreign coat',
            category='outerwear',
        )
        self.own_outfit = Outfit.objects.create(
            owner=self.owner,
            name='My outfit',
        )
        self.other_outfit = Outfit.objects.create(
            owner=self.other_user,
            name='Other outfit',
        )

    def outfit_payload(self, **overrides):
        payload = {
            'name': 'Weekend outfit',
            'occasion': 'daily',
            'season': 'summer',
            'garments': [
                {'garment': self.own_garment.pk, 'role': 'top', 'order': 1},
                {'garment': self.second_garment.pk, 'role': 'bottom', 'order': 2},
            ],
        }
        payload.update(overrides)
        return payload

    def test_create_outfit_assigns_owner_and_persists_through_fields(self):
        response = self.client.post(
            self.list_url,
            self.outfit_payload(owner=self.other_user.pk),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        outfit = Outfit.objects.get(pk=response.data['id'])
        self.assertEqual(outfit.owner, self.owner)
        self.assertEqual(response.data['owner'], self.owner.pk)
        links = list(outfit.outfit_garments.order_by('order'))
        self.assertEqual(len(links), 2)
        self.assertEqual(
            [(link.garment_id, link.role, link.order) for link in links],
            [
                (self.own_garment.pk, 'top', 1),
                (self.second_garment.pk, 'bottom', 2),
            ],
        )
        self.assertEqual(
            response.data['garments'][0]['garment_details']['name'],
            'Owner shirt',
        )

    def test_list_only_returns_current_users_outfits(self):
        Outfit.objects.create(owner=self.other_user, name='Hidden outfit')

        response = self.client.get(self.list_url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            {item['id'] for item in response.data},
            {self.own_outfit.pk},
        )

    def test_owner_can_retrieve_update_and_delete_outfit(self):
        self.own_outfit.garments.add(self.own_garment)
        detail_url = f'{self.list_url}{self.own_outfit.pk}/'

        get_response = self.client.get(detail_url)
        self.assertEqual(get_response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            get_response.data['garments'][0]['garment_details']['id'],
            self.own_garment.pk,
        )

        patch_response = self.client.patch(
            detail_url,
            {
                'name': 'Updated outfit',
                'garments': [
                    {'garment': self.second_garment.pk, 'role': 'bottom', 'order': 3}
                ],
            },
            format='json',
        )
        self.assertEqual(patch_response.status_code, status.HTTP_200_OK)
        self.own_outfit.refresh_from_db()
        self.assertEqual(self.own_outfit.name, 'Updated outfit')
        self.assertEqual(
            list(
                self.own_outfit.outfit_garments.values_list(
                    'garment_id',
                    'role',
                    'order',
                )
            ),
            [(self.second_garment.pk, 'bottom', 3)],
        )

        delete_response = self.client.delete(detail_url)
        self.assertEqual(delete_response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Outfit.objects.filter(pk=self.own_outfit.pk).exists())

    def test_outfit_details_include_archived_garment_details(self):
        self.own_garment.subcategory = 'button-down'
        self.own_garment.secondary_colors = ['cream', 'olive']
        self.own_garment.pattern = 'striped'
        self.own_garment.material = 'cotton'
        self.own_garment.style = 'casual'
        self.own_garment.description = 'A historical garment.'
        self.own_garment.is_archived = True
        self.own_garment.save()
        OutfitGarment.objects.create(
            outfit=self.own_outfit,
            garment=self.own_garment,
            role='top',
            order=1,
        )

        response = self.client.get(f'{self.list_url}{self.own_outfit.pk}/')

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.data['garments'][0]['garment_details']['id'],
            self.own_garment.pk,
        )
        self.assertTrue(
            response.data['garments'][0]['garment_details']['is_archived']
        )
        garment_details = response.data['garments'][0]['garment_details']
        self.assertEqual(garment_details['subcategory'], 'button-down')
        self.assertEqual(
            garment_details['secondary_colors'],
            ['cream', 'olive'],
        )
        self.assertEqual(garment_details['pattern'], 'striped')
        self.assertEqual(garment_details['material'], 'cotton')
        self.assertEqual(garment_details['style'], 'casual')
        self.assertEqual(
            garment_details['description'],
            'A historical garment.',
        )

    def test_archived_garment_cannot_be_added_to_new_outfit(self):
        self.own_garment.is_archived = True
        self.own_garment.save()

        response = self.client.post(
            self.list_url,
            self.outfit_payload(
                garments=[
                    {'garment': self.own_garment.pk, 'role': 'top', 'order': 1},
                ]
            ),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Outfit.objects.filter(owner=self.owner).count(), 1)
        self.assertFalse(
            OutfitGarment.objects.filter(
                outfit__owner=self.owner,
                garment=self.own_garment,
            ).exists()
        )

    def test_updating_outfit_preserves_existing_archived_garment_relation(self):
        self.own_garment.is_archived = True
        self.own_garment.save()
        archived_link = OutfitGarment.objects.create(
            outfit=self.own_outfit,
            garment=self.own_garment,
            role='archived-top',
            order=7,
        )
        OutfitGarment.objects.create(
            outfit=self.own_outfit,
            garment=self.second_garment,
            role='bottom',
            order=2,
        )

        response = self.client.patch(
            f'{self.list_url}{self.own_outfit.pk}/',
            {
                'name': 'Updated outfit',
                'garments': [
                    {'garment': self.second_garment.pk, 'role': 'bottom', 'order': 3},
                ],
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(OutfitGarment.objects.filter(pk=archived_link.pk).exists())
        archived_link.refresh_from_db()
        self.assertEqual(archived_link.role, 'archived-top')
        self.assertEqual(archived_link.order, 7)
        self.assertTrue(
            OutfitGarment.objects.filter(
                outfit=self.own_outfit,
                garment=self.second_garment,
                order=3,
            ).exists()
        )

    def test_other_user_cannot_access_an_outfit(self):
        self.client.force_authenticate(user=self.other_user)
        detail_url = f'{self.list_url}{self.own_outfit.pk}/'

        self.assertEqual(
            self.client.get(detail_url).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            self.client.patch(
                detail_url,
                {'name': 'Unauthorized edit'},
                format='json',
            ).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            self.client.delete(detail_url).status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_foreign_garment_is_rejected_without_creating_outfit_or_link(self):
        response = self.client.post(
            self.list_url,
            self.outfit_payload(
                garments=[
                    {'garment': self.foreign_garment.pk, 'role': 'coat', 'order': 1}
                ]
            ),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Outfit.objects.filter(owner=self.owner).count(), 1)
        self.assertFalse(
            OutfitGarment.objects.filter(garment=self.foreign_garment).exists()
        )

    def test_client_cannot_change_outfit_owner(self):
        detail_url = f'{self.list_url}{self.own_outfit.pk}/'
        response = self.client.patch(
            detail_url,
            {'owner': self.other_user.pk, 'name': 'Still mine'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.own_outfit.refresh_from_db()
        self.assertEqual(self.own_outfit.owner, self.owner)

    def test_anonymous_user_cannot_list_or_create_outfits(self):
        self.client.force_authenticate(user=None)

        self.assertEqual(
            self.client.get(self.list_url).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(
            self.client.post(
                self.list_url,
                self.outfit_payload(),
                format='json',
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )

    def test_create_rolls_back_outfit_when_through_row_save_fails(self):
        original_save = OutfitGarment.save

        def save_then_fail(instance, *args, **kwargs):
            original_save(instance, *args, **kwargs)
            raise IntegrityError('Simulated through-row database failure')

        initial_count = Outfit.objects.filter(owner=self.owner).count()
        with mock.patch.object(OutfitGarment, 'save', autospec=True, side_effect=save_then_fail):
            with self.assertRaises(IntegrityError):
                self.client.post(
                    self.list_url,
                    self.outfit_payload(),
                    format='json',
                )

        self.assertEqual(Outfit.objects.filter(owner=self.owner).count(), initial_count)
        self.assertFalse(
            OutfitGarment.objects.filter(
                outfit__owner=self.owner,
                garment__in=(self.own_garment, self.second_garment),
            ).exists()
        )

    def test_update_rolls_back_outfit_and_old_links_when_new_link_save_fails(self):
        self.own_outfit.name = 'Original outfit'
        self.own_outfit.save()
        self.own_outfit.outfit_garments.create(
            garment=self.own_garment,
            role='original',
            order=4,
        )
        original_links = list(
            self.own_outfit.outfit_garments.order_by('pk').values_list(
                'garment_id',
                'role',
                'order',
            )
        )
        original_save = OutfitGarment.save

        def save_then_fail(instance, *args, **kwargs):
            original_save(instance, *args, **kwargs)
            raise IntegrityError('Simulated through-row database failure')

        detail_url = f'{self.list_url}{self.own_outfit.pk}/'
        with mock.patch.object(OutfitGarment, 'save', autospec=True, side_effect=save_then_fail):
            with self.assertRaises(IntegrityError):
                self.client.patch(
                    detail_url,
                    {
                        'name': 'Partially updated outfit',
                        'garments': [
                            {
                                'garment': self.second_garment.pk,
                                'role': 'new',
                                'order': 9,
                            }
                        ],
                    },
                    format='json',
                )

        self.own_outfit.refresh_from_db()
        self.assertEqual(self.own_outfit.name, 'Original outfit')
        self.assertEqual(
            list(
                self.own_outfit.outfit_garments.order_by('pk').values_list(
                    'garment_id',
                    'role',
                    'order',
                )
            ),
            original_links,
        )


class CalendarPlanAPITests(TestCase):
    list_url = '/api/closet/calendar/'

    def setUp(self):
        user_model = get_user_model()
        self.owner = user_model.objects.create_user(
            username='calendar-owner',
            password='test-password',
        )
        self.other_user = user_model.objects.create_user(
            username='calendar-other',
            password='test-password',
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.owner)
        self.own_outfit = Outfit.objects.create(
            owner=self.owner,
            name='My calendar outfit',
        )
        self.second_outfit = Outfit.objects.create(
            owner=self.owner,
            name='Second outfit',
        )
        self.foreign_outfit = Outfit.objects.create(
            owner=self.other_user,
            name='Foreign outfit',
        )

    def calendar_payload(self, **overrides):
        payload = {
            'date': '2026-11-01',
            'outfit': self.own_outfit.pk,
        }
        payload.update(overrides)
        return payload

    def test_create_calendar_plan_for_current_users_outfit(self):
        response = self.client.post(
            self.list_url,
            self.calendar_payload(),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        plan = CalendarPlan.objects.get(pk=response.data['id'])
        self.assertEqual(plan.owner, self.owner)
        self.assertEqual(plan.outfit, self.own_outfit)
        self.assertEqual(response.data['date'], '2026-11-01')

    def test_list_only_returns_current_users_calendar_plans(self):
        own_plan = CalendarPlan.objects.create(
            owner=self.owner,
            date=date(2026, 11, 1),
            outfit=self.own_outfit,
        )
        CalendarPlan.objects.create(
            owner=self.other_user,
            date=date(2026, 11, 1),
            outfit=self.foreign_outfit,
        )

        response = self.client.get(self.list_url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [item['id'] for item in response.data],
            [own_plan.pk],
        )

    def test_owner_can_retrieve_update_and_delete_calendar_plan(self):
        plan = CalendarPlan.objects.create(
            owner=self.owner,
            date=date(2026, 11, 1),
            outfit=self.own_outfit,
        )
        detail_url = f'{self.list_url}{plan.pk}/'

        get_response = self.client.get(detail_url)
        self.assertEqual(get_response.status_code, status.HTTP_200_OK)

        patch_response = self.client.patch(
            detail_url,
            {'date': '2026-11-02', 'outfit': self.second_outfit.pk},
            format='json',
        )
        self.assertEqual(patch_response.status_code, status.HTTP_200_OK)
        plan.refresh_from_db()
        self.assertEqual(plan.date, date(2026, 11, 2))
        self.assertEqual(plan.outfit, self.second_outfit)

        delete_response = self.client.delete(detail_url)
        self.assertEqual(delete_response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(CalendarPlan.objects.filter(pk=plan.pk).exists())

    def test_foreign_users_outfit_is_rejected(self):
        response = self.client.post(
            self.list_url,
            self.calendar_payload(outfit=self.foreign_outfit.pk),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(CalendarPlan.objects.filter(owner=self.owner).exists())

    def test_client_cannot_change_calendar_plan_owner(self):
        response = self.client.post(
            self.list_url,
            self.calendar_payload(owner=self.other_user.pk),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(
            CalendarPlan.objects.get(pk=response.data['id']).owner,
            self.owner,
        )

    def test_other_user_cannot_access_calendar_plan(self):
        plan = CalendarPlan.objects.create(
            owner=self.other_user,
            date=date(2026, 11, 1),
            outfit=self.foreign_outfit,
        )
        self.client.force_authenticate(user=self.owner)
        detail_url = f'{self.list_url}{plan.pk}/'

        self.assertEqual(
            self.client.get(detail_url).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            self.client.patch(
                detail_url,
                {'date': '2026-11-02'},
                format='json',
            ).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.assertEqual(
            self.client.delete(detail_url).status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_anonymous_user_cannot_access_calendar_api(self):
        self.client.force_authenticate(user=None)

        self.assertEqual(
            self.client.get(self.list_url).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(
            self.client.post(
                self.list_url,
                self.calendar_payload(),
                format='json',
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )

    def test_duplicate_plan_for_same_user_and_date_is_rejected(self):
        first_response = self.client.post(
            self.list_url,
            self.calendar_payload(),
            format='json',
        )
        duplicate_response = self.client.post(
            self.list_url,
            self.calendar_payload(outfit=self.second_outfit.pk),
            format='json',
        )

        self.assertEqual(first_response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(
            duplicate_response.status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertIn('date', duplicate_response.data)
        self.assertEqual(CalendarPlan.objects.filter(owner=self.owner).count(), 1)

    def test_updating_to_an_existing_date_preserves_previous_plan_data(self):
        first_plan = CalendarPlan.objects.create(
            owner=self.owner,
            date=date(2026, 11, 1),
            outfit=self.own_outfit,
        )
        second_plan = CalendarPlan.objects.create(
            owner=self.owner,
            date=date(2026, 11, 2),
            outfit=self.second_outfit,
        )
        detail_url = f'{self.list_url}{second_plan.pk}/'

        response = self.client.patch(
            detail_url,
            {'date': '2026-11-01'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('date', response.data)
        second_plan.refresh_from_db()
        self.assertEqual(second_plan.date, date(2026, 11, 2))
        self.assertEqual(second_plan.outfit, self.second_outfit)
        self.assertEqual(first_plan.date, date(2026, 11, 1))

    def test_date_constraint_integrity_error_is_translated_after_rollback(self):
        error = IntegrityError(
            'UNIQUE constraint failed: '
            'closet_calendarplan.owner_id, closet_calendarplan.date'
        )
        with mock.patch.object(CalendarPlan, 'save', autospec=True, side_effect=error):
            response = self.client.post(
                self.list_url,
                self.calendar_payload(date='2026-11-03'),
                format='json',
            )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('date', response.data)
        self.assertFalse(
            CalendarPlan.objects.filter(
                owner=self.owner,
                date=date(2026, 11, 3),
            ).exists()
        )

    def test_unrelated_integrity_error_is_not_converted_to_date_error(self):
        error = IntegrityError('UNIQUE constraint failed: unrelated_table.field')
        with mock.patch.object(CalendarPlan, 'save', autospec=True, side_effect=error):
            with self.assertRaises(IntegrityError):
                self.client.post(
                    self.list_url,
                    self.calendar_payload(date='2026-11-03'),
                    format='json',
                )

    def test_different_users_can_plan_on_the_same_date(self):
        owner_response = self.client.post(
            self.list_url,
            self.calendar_payload(),
            format='json',
        )
        self.client.force_authenticate(user=self.other_user)
        other_response = self.client.post(
            self.list_url,
            {'date': '2026-11-01', 'outfit': self.foreign_outfit.pk},
            format='json',
        )

        self.assertEqual(owner_response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(other_response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(
            CalendarPlan.objects.filter(date=date(2026, 11, 1)).count(),
            2,
        )

    def test_non_iso_date_format_is_rejected(self):
        response = self.client.post(
            self.list_url,
            self.calendar_payload(date='01-11-2026'),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('date', response.data)

    def test_iso_date_input_is_accepted(self):
        response = self.client.post(
            self.list_url,
            self.calendar_payload(date='2026-11-01'),
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['date'], '2026-11-01')


class UserPreferencesAPITests(TestCase):
    url = '/api/closet/preferences/'

    def setUp(self):
        user_model = get_user_model()
        self.owner = user_model.objects.create_user(
            username='preferences-owner',
            password='test-password',
        )
        self.other_user = user_model.objects.create_user(
            username='preferences-other',
            password='test-password',
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.owner)

    def test_get_returns_and_creates_default_preferences(self):
        response = self.client.get(self.url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['owner'], self.owner.pk)
        self.assertEqual(response.data['style_preferences'], {})
        self.assertEqual(response.data['color_preferences'], {})
        self.assertEqual(
            UserPreferences.objects.filter(owner=self.owner).count(),
            1,
        )

    def test_repeated_get_does_not_create_duplicate_preferences(self):
        first_response = self.client.get(self.url)
        second_response = self.client.get(self.url)

        self.assertEqual(first_response.status_code, status.HTTP_200_OK)
        self.assertEqual(second_response.status_code, status.HTTP_200_OK)
        self.assertEqual(first_response.data['id'], second_response.data['id'])
        self.assertEqual(
            UserPreferences.objects.filter(owner=self.owner).count(),
            1,
        )

    def test_user_only_receives_and_updates_their_own_preferences(self):
        other_preferences = UserPreferences.objects.create(
            owner=self.other_user,
            style_preferences={'private': 'other-user-style'},
            color_preferences={'private': 'other-user-color'},
        )

        response = self.client.get(self.url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['owner'], self.owner.pk)
        self.assertNotEqual(response.data['id'], other_preferences.pk)

        owner_update = self.client.patch(
            self.url,
            {
                'style_preferences': {'name': 'Owner', 'style': 'minimal'},
                'color_preferences': {'palette': 'earth'},
            },
            format='json',
        )
        self.assertEqual(owner_update.status_code, status.HTTP_200_OK)
        other_preferences.refresh_from_db()
        self.assertEqual(
            other_preferences.style_preferences,
            {'private': 'other-user-style'},
        )
        self.assertEqual(
            other_preferences.color_preferences,
            {'private': 'other-user-color'},
        )

        self.client.force_authenticate(user=self.other_user)
        other_response = self.client.get(self.url)
        self.assertEqual(other_response.status_code, status.HTTP_200_OK)
        self.assertEqual(other_response.data['owner'], self.other_user.pk)
        self.assertEqual(
            other_response.data['style_preferences'],
            {'private': 'other-user-style'},
        )
        self.assertEqual(
            other_response.data['color_preferences'],
            {'private': 'other-user-color'},
        )

        other_update = self.client.patch(
            self.url,
            {
                'style_preferences': {'name': 'Other', 'style': 'classic'},
                'color_preferences': {'palette': 'dark'},
            },
            format='json',
        )
        self.assertEqual(other_update.status_code, status.HTTP_200_OK)
        self.assertEqual(other_update.data['owner'], self.other_user.pk)
        self.assertEqual(
            other_update.data['style_preferences'],
            {'name': 'Other', 'style': 'classic'},
        )
        self.assertEqual(
            other_update.data['color_preferences'],
            {'palette': 'dark'},
        )
        self.client.force_authenticate(user=self.owner)
        owner_response = self.client.get(self.url)
        self.assertEqual(owner_response.data['style_preferences'], {
            'name': 'Owner',
            'style': 'minimal',
        })
        self.assertEqual(owner_response.data['color_preferences'], {
            'palette': 'earth',
        })

    def test_patch_updates_both_preference_fields(self):
        response = self.client.patch(
            self.url,
            {
                'style_preferences': {'name': 'Closeté', 'style': 'minimal'},
                'color_preferences': {'palette': 'neutral'},
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.data['style_preferences'],
            {'name': 'Closeté', 'style': 'minimal'},
        )
        self.assertEqual(
            response.data['color_preferences'],
            {'palette': 'neutral'},
        )

    def test_put_updates_both_preference_fields(self):
        preferences = UserPreferences.objects.create(
            owner=self.owner,
            style_preferences={'old': True},
            color_preferences={'old': True},
        )

        response = self.client.put(
            self.url,
            {
                'style_preferences': {'style': 'classic'},
                'color_preferences': {'palette': ['blue', 'cream']},
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        preferences.refresh_from_db()
        self.assertEqual(
            preferences.style_preferences,
            {'style': 'classic'},
        )
        self.assertEqual(
            preferences.color_preferences,
            {'palette': ['blue', 'cream']},
        )

    def test_put_uses_empty_object_defaults_for_omitted_preferences(self):
        preferences = UserPreferences.objects.create(
            owner=self.owner,
            style_preferences={'style': 'classic'},
            color_preferences={'palette': 'blue'},
        )

        response = self.client.put(
            self.url,
            {'style_preferences': {'style': 'minimal'}},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        preferences.refresh_from_db()
        self.assertEqual(preferences.style_preferences, {'style': 'minimal'})
        self.assertEqual(preferences.color_preferences, {})

    def test_patch_updates_one_field_without_overwriting_the_other(self):
        preferences = UserPreferences.objects.create(
            owner=self.owner,
            style_preferences={'style': 'classic'},
            color_preferences={'palette': 'blue'},
        )

        response = self.client.patch(
            self.url,
            {'style_preferences': {'style': 'minimal'}},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        preferences.refresh_from_db()
        self.assertEqual(preferences.style_preferences, {'style': 'minimal'})
        self.assertEqual(preferences.color_preferences, {'palette': 'blue'})

    def test_client_cannot_change_preferences_owner(self):
        response = self.client.patch(
            self.url,
            {
                'owner': self.other_user.pk,
                'style_preferences': {'style': 'minimal'},
            },
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        preferences = UserPreferences.objects.get(owner=self.owner)
        self.assertEqual(preferences.owner, self.owner)
        self.assertFalse(
            UserPreferences.objects.filter(owner=self.other_user).exists()
        )

    def test_anonymous_user_cannot_access_preferences(self):
        self.client.force_authenticate(user=None)

        self.assertEqual(
            self.client.get(self.url).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(
            self.client.put(
                self.url,
                {'style_preferences': {}, 'color_preferences': {}},
                format='json',
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )

    def test_non_object_preference_values_are_rejected(self):
        invalid_values = ([], 'value', 7, None)
        for field in ('style_preferences', 'color_preferences'):
            for value in invalid_values:
                with self.subTest(field=field, value=value):
                    response = self.client.patch(
                        self.url,
                        {field: value},
                        format='json',
                    )

                    self.assertEqual(
                        response.status_code,
                        status.HTTP_400_BAD_REQUEST,
                    )
                    self.assertIn(field, response.data)

    def test_get_or_create_recovers_when_one_to_one_record_already_exists(self):
        existing = UserPreferences.objects.create(
            owner=self.owner,
            style_preferences={'style': 'existing'},
        )

        response = self.client.get(self.url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['id'], existing.pk)
        self.assertEqual(
            UserPreferences.objects.filter(owner=self.owner).count(),
            1,
        )
