from django.test import Client, TestCase, override_settings
from django.urls import reverse

from products.models import Product


@override_settings(MIDDLEWARE=[
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
])
class RemoveFromCartTests(TestCase):
    def setUp(self):
        self.client = Client(enforce_csrf_checks=True)
        self.product = Product.objects.create(
            title='Test product',
            description='Test description',
        )
        self.remove_url = reverse('cart:cart_remove', args=[self.product.pk])
        session = self.client.session
        session['cart'] = {str(self.product.pk): {'quantity': 1}}
        session.save()

    def test_get_does_not_remove_product_from_cart(self):
        response = self.client.get(self.remove_url)

        self.assertEqual(response.status_code, 405)
        self.assertIn(str(self.product.pk), self.client.session['cart'])

    def test_post_without_csrf_token_is_rejected(self):
        response = self.client.post(self.remove_url)

        self.assertEqual(response.status_code, 403)
        self.assertIn(str(self.product.pk), self.client.session['cart'])

    def test_csrf_protected_post_removes_product_from_cart(self):
        cart_page = self.client.get(reverse('cart:cart_detail'))
        self.assertEqual(cart_page.status_code, 200)
        csrf_token = self.client.cookies['csrftoken'].value

        response = self.client.post(
            self.remove_url,
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertRedirects(response, reverse('cart:cart_detail'))
        self.assertNotIn(str(self.product.pk), self.client.session['cart'])
