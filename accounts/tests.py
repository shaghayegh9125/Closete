from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse


class SessionChangeBroadcastTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="closete-user",
            email="closete-user@example.com",
            password="test-password-123",
        )

    def test_successful_login_broadcasts_on_home_destination(self):
        response = self.client.post(
            reverse("account_login"),
            {"login": self.user.email, "password": "test-password-123"},
            follow=True,
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'channel.postMessage({ type: "session-changed" })')
        self.assertTrue(response.wsgi_request.user.is_authenticated)

    def test_successful_login_broadcasts_on_standalone_closet_destination(self):
        response = self.client.post(
            f'{reverse("account_login")}?next=/wardrobe/',
            {"login": self.user.email, "password": "test-password-123"},
            follow=True,
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'channel.postMessage({ type: "session-changed" })')
        self.assertTrue(response.wsgi_request.user.is_authenticated)

    def test_failed_login_does_not_broadcast(self):
        response = self.client.post(
            reverse("account_login"),
            {"login": self.user.email, "password": "wrong-password"},
            follow=True,
        )

        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, 'channel.postMessage({ type: "session-changed" })')
        self.assertFalse(response.wsgi_request.user.is_authenticated)

    def test_logout_confirmation_does_not_broadcast(self):
        self.client.force_login(self.user)

        response = self.client.get(reverse("account_logout"))

        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, 'channel.postMessage({ type: "session-changed" })')
        self.assertTrue(response.wsgi_request.user.is_authenticated)

    def test_successful_logout_broadcasts_after_redirect(self):
        self.client.force_login(self.user)

        response = self.client.post(reverse("account_logout"), follow=True)

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'channel.postMessage({ type: "session-changed" })')
        self.assertFalse(response.wsgi_request.user.is_authenticated)
