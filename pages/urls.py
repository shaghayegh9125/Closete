from django.urls import path

from . import views

urlpatterns = [
    path('', views.HomePageView.as_view(), name='home'),
    path('wardrobe/', views.ClosetPageView.as_view(), name='wardrobe'),
    path('aboutus/', views.AboutUsPageView.as_view(), name='aboutus'),
]
