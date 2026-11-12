from django.contrib import messages
from allauth.account.views import LogoutView

from .signals import SESSION_CHANGE_MESSAGE, SESSION_CHANGE_TAG


class CloseteLogoutView(LogoutView):
    def post(self, *args, **kwargs):
        was_authenticated = self.request.user.is_authenticated
        response = super().post(*args, **kwargs)
        if was_authenticated and 300 <= response.status_code < 400:
            messages.add_message(
                self.request,
                messages.INFO,
                SESSION_CHANGE_MESSAGE,
                extra_tags=SESSION_CHANGE_TAG,
            )
        return response