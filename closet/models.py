from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import FileExtensionValidator
from django.db import models
from PIL import Image, UnidentifiedImageError


MAX_IMAGE_DIMENSION = 6000
MAX_IMAGE_PIXELS = 25_000_000
MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024
IMAGE_FORMATS_BY_EXTENSION = {
    'jpg': 'JPEG',
    'jpeg': 'JPEG',
    'png': 'PNG',
    'webp': 'WEBP',
}


def validate_image_size(image):
    if image.size > MAX_IMAGE_SIZE_BYTES:
        raise ValidationError('Image file size must not exceed 5 MB.')


def validate_image_content_and_dimensions(image):
    if image.size > MAX_IMAGE_SIZE_BYTES:
        return

    extension = image.name.rsplit('.', 1)[-1].lower()
    expected_format = IMAGE_FORMATS_BY_EXTENSION.get(extension)

    try:
        image.seek(0)
        with Image.open(image) as uploaded_image:
            if uploaded_image.format != expected_format:
                raise ValidationError(
                    'Image content must match its file extension.'
                )

            width, height = uploaded_image.size
            if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
                raise ValidationError(
                    'Image dimensions must not exceed 6000 pixels per side.'
                )
            if width * height > MAX_IMAGE_PIXELS:
                raise ValidationError(
                    'Image must not contain more than 25 million pixels.'
                )

            uploaded_image.verify()
        image.seek(0)
        with Image.open(image) as decoded_image:
            decoded_image.load()
    except ValidationError:
        raise
    except (
        Image.DecompressionBombError,
        EOFError,
        OSError,
        SyntaxError,
        UnidentifiedImageError,
        ValueError,
    ) as error:
        raise ValidationError(
            'Upload a valid, non-corrupted image.'
        ) from error
    finally:
        image.seek(0)


def validate_secondary_colors(value):
    if not isinstance(value, list) or not all(
        isinstance(color, str) for color in value
    ):
        raise ValidationError(
            'Secondary colors must be a list of strings.'
        )


class Garment(models.Model):
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='closet_garments',
    )
    name = models.CharField(max_length=200)
    category = models.CharField(max_length=100)
    subcategory = models.CharField(max_length=100, blank=True)
    color = models.CharField(max_length=100, blank=True)
    secondary_colors = models.JSONField(
        blank=True,
        default=list,
        validators=[validate_secondary_colors],
    )
    pattern = models.CharField(max_length=100, blank=True)
    season = models.CharField(max_length=100, blank=True)
    occasion = models.CharField(max_length=100, blank=True)
    material = models.CharField(max_length=100, blank=True)
    style = models.CharField(max_length=100, blank=True)
    description = models.TextField(blank=True)
    favorite = models.BooleanField(default=False)
    is_archived = models.BooleanField(default=False)
    image = models.ImageField(
        upload_to='closet/garments/',
        blank=True,
        validators=[
            FileExtensionValidator(allowed_extensions=('jpg', 'jpeg', 'png', 'webp')),
            validate_image_size,
            validate_image_content_and_dimensions,
        ],
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name


class Outfit(models.Model):
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='closet_outfits',
    )
    name = models.CharField(max_length=200)
    occasion = models.CharField(max_length=100, blank=True)
    season = models.CharField(max_length=100, blank=True)
    garments = models.ManyToManyField(
        Garment,
        through='OutfitGarment',
        related_name='outfits',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name


class OutfitGarment(models.Model):
    outfit = models.ForeignKey(
        Outfit,
        on_delete=models.CASCADE,
        related_name='outfit_garments',
    )
    garment = models.ForeignKey(
        Garment,
        on_delete=models.PROTECT,
        related_name='outfit_garments',
    )
    role = models.CharField(max_length=50, blank=True)
    order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=('outfit', 'garment'),
                name='unique_garment_per_outfit',
            ),
        ]
        ordering = ('order', 'pk')

    def clean(self):
        super().clean()
        if self.outfit_id and self.garment_id:
            if self.outfit.owner_id != self.garment.owner_id:
                raise ValidationError(
                    'An outfit and its garments must belong to the same user.'
                )

    def save(self, *args, **kwargs):
        """Validate ownership before saving; bulk_create and QuerySet.update bypass model validation."""
        self.full_clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f'{self.outfit}: {self.garment}'


class CalendarPlan(models.Model):
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='closet_calendar_plans',
    )
    date = models.DateField()
    outfit = models.ForeignKey(
        Outfit,
        on_delete=models.PROTECT,
        related_name='calendar_plans',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=('owner', 'date'),
                name='unique_calendar_plan_per_owner_date',
            ),
        ]
        ordering = ('date',)

    def clean(self):
        super().clean()
        if self.owner_id and self.outfit_id:
            if self.owner_id != self.outfit.owner_id:
                raise ValidationError(
                    'A calendar plan and its outfit must belong to the same user.'
                )

    def save(self, *args, **kwargs):
        """Validate ownership; bulk_create and QuerySet.update bypass model validation."""
        self.full_clean()
        return super().save(*args, **kwargs)

    def __str__(self):
        return f'{self.owner} - {self.date}: {self.outfit}'


class UserPreferences(models.Model):
    owner = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='closet_preferences',
    )
    style_preferences = models.JSONField(default=dict, blank=True)
    color_preferences = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'Preferences for {self.owner}'
