from django.contrib import messages
from django.dispatch import receiver

from allauth.account.signals import user_logged_in


SESSION_CHANGE_TAG = "closete-session-changed"
SESSION_CHANGE_MESSAGE = "session-changed"


@receiver(user_logged_in)
def notify_session_change_after_login(sender, request, response, **kwargs):
    if 300 <= response.status_code < 400:
        messages.add_message(
            request,
            messages.INFO,
            SESSION_CHANGE_MESSAGE,
            extra_tags=SESSION_CHANGE_TAG,
        )
