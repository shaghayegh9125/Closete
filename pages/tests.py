from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse


class ClosetePagesTests(TestCase):
    def test_landing_page_renders_primary_message_and_wardrobe_link(self):
        response = self.client.get(reverse("home"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "کمدت را بشناس")
        self.assertContains(response, reverse("wardrobe"))

    def test_anonymous_wardrobe_request_redirects_to_login_with_next(self):
        response = self.client.get(reverse("wardrobe"))

        self.assertRedirects(
            response,
            f"{reverse('account_login')}?next={reverse('wardrobe')}",
            fetch_redirect_response=False,
        )

    def test_wardrobe_workspace_renders_all_primary_views(self):
        user = get_user_model().objects.create_user(
            username="closet-user",
            email="closet@example.com",
            password="test-password",
        )
        self.client.force_login(user)

        response = self.client.get(reverse("wardrobe"))

        self.assertEqual(response.status_code, 200)
        for view in ("dashboard", "wardrobe", "outfits", "builder", "stylist", "calendar", "settings"):
            self.assertContains(response, f'data-page="{view}"')
        self.assertContains(response, "closet.js")

    def test_login_and_signup_pages_still_render(self):
        for url_name in ("account_login", "account_signup"):
            with self.subTest(url_name=url_name):
                response = self.client.get(reverse(url_name))

                self.assertEqual(response.status_code, 200)
