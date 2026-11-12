from django.urls import path

from .views import (
    CalendarPlanDetailView,
    CalendarPlanListCreateView,
    CurrentUserView,
    GarmentDetailView,
    GarmentImageView,
    GarmentListCreateView,
    OutfitDetailView,
    OutfitListCreateView,
    UserPreferencesView,
)

app_name = 'closet'

urlpatterns = [
    path('garments/', GarmentListCreateView.as_view(), name='garment-list'),
    path('garments/<int:pk>/', GarmentDetailView.as_view(), name='garment-detail'),
    path(
        'garments/<int:pk>/image/',
        GarmentImageView.as_view(),
        name='garment-image',
    ),
    path('outfits/', OutfitListCreateView.as_view(), name='outfit-list'),
    path('outfits/<int:pk>/', OutfitDetailView.as_view(), name='outfit-detail'),
    path('me/', CurrentUserView.as_view(), name='current-user'),
    path('calendar/', CalendarPlanListCreateView.as_view(), name='calendar-list'),
    path('calendar/<int:pk>/', CalendarPlanDetailView.as_view(), name='calendar-detail'),
    path('preferences/', UserPreferencesView.as_view(), name='preferences'),
]
