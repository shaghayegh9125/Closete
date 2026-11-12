(function () {
  "use strict";

  const body = document.body;
  const imageRoot = body.dataset.images || "/static/img/products/";
  const categoryNames = {
    tops: "بالاپوش", trousers: "شلوار", skirts: "دامن", dresses: "پیراهن",
    outerwear: "رویه", shoes: "کفش", accessories: "اکسسوری"
  };
  const categories = Object.keys(categoryNames);
  const colors = ["کرم", "مشکی", "سفید", "قهوه‌ای", "زیتونی", "سرمه‌ای", "خاکستری", "زرشکی"];
  const defaultImage = imageRoot + "look-03.jpg";
  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));
  const id = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const faNumber = value => new Intl.NumberFormat("fa-IR").format(value);
  const persianDateFormatter = new Intl.DateTimeFormat("en-US-u-ca-persian", {
    year: "numeric", month: "numeric", day: "numeric"
  });
  const persianDateParts = date => {
    const parts = persianDateFormatter.formatToParts(date);
    return {
      year: Number(parts.find(part => part.type === "year").value),
      month: Number(parts.find(part => part.type === "month").value),
      day: Number(parts.find(part => part.type === "day").value)
    };
  };
  const persianDateKey = (year, month, day) =>
    `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const localDateKey = date => {
    const { year, month, day } = persianDateParts(date);
    return persianDateKey(year, month, day);
  };
  const dateFromKey = key => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!match) return null;
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;

    const date = new Date(year + 621, 0, 1, 12);
    for (let offset = 0; offset < 430; offset++) {
      const candidate = new Date(date);
      candidate.setDate(date.getDate() + offset);
      const parts = persianDateParts(candidate);
      if (parts.year === year && parts.month === month && parts.day === day) return candidate;
    }
    return null;
  };
  const persianDateToGregorianISO = key => {
    const date = dateFromKey(key);
    if (!date || localDateKey(date) !== key) return null;
    return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const gregorianISOToPersianKey = value => {
    if (typeof value !== "string") return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(12, 0, 0, 0);
    if (
      date.getFullYear() !== year ||
      date.getMonth() + 1 !== month ||
      date.getDate() !== day
    ) return null;
    return localDateKey(date);
  };
  const persianMonthStart = (year, month) => dateFromKey(persianDateKey(year, month, 1));
  const shiftPersianMonth = (year, month, amount) => {
    const absoluteMonth = year * 12 + month - 1 + amount;
    return {
      year: Math.floor(absoluteMonth / 12),
      month: (absoluteMonth % 12) + 1
    };
  };
  const escapeHTML = value => String(value == null ? "" : value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[char]);

  const isRecord = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const preferredStyles = ["مینیمال", "کژوال", "کلاسیک", "رسمی", "رنگی و جسور"];
  const isSettingsValid = settings =>
    isRecord(settings) &&
    typeof settings.name === "string" &&
    settings.name.length <= 40 &&
    preferredStyles.includes(settings.style) &&
    ["neutral", "earth", "dark"].includes(settings.palette);
  const defaultSettings = () => ({ name: "", style: "مینیمال", palette: "neutral" });

  const identity = { status: "unknown", userId: null, errorMessage: "" };
  let identityRequest = null;
  let pendingSessionChange = false;
  let identityChannel = null;
  let identityEventsInstalled = false;
  let personalAppInitialized = false;
  let personalAppUserId = null;
  let state;
  let userData = { settings: defaultSettings() };
  let savedPreferences = null;
  let preferencesLoaded = false;
  let preferencesLoading = false;
  let preferencesSaving = false;
  let preferencesRequestId = 0;
  let preferencesNeedsRetry = false;
  const serverWardrobe = { status: "idle", garments: [], archivedGarments: [], error: "" };
  const pendingGarmentUpdates = new Set();
  const pendingGarmentDeletes = new Set();
  const pendingOutfitDeletes = new Set();
  let deleteGarmentDialogId = null;
  let deleteGarmentReturnFocus = null;
  let garmentSubmissionInProgress = false;
  let serverWardrobeRequest = null;
  const serverOutfits = { status: "idle", outfits: [], error: "", ownerId: null };
  const serverCalendar = { status: "idle", plans: [], error: "", ownerId: null };
  let serverOutfitsRequest = null;
  let serverOutfitsDataVersion = 0;
  let serverCalendarRequest = null;
  let calendarCsrfToken = "";
  let lastCalendarRefreshAt = 0;
  let calendarSessionVersion = 0;
  const pendingCalendarDates = new Set();
  let wardrobeMode = "server";
  let outfitSource = "server";
  let previousScrollOverflow = null;
  let previousDrawerMode = window.innerWidth <= 900;

  function isIdentityReady() {
    return identity.status === "ready" && Number.isSafeInteger(identity.userId);
  }

  function setIdentityStatus(status) {
    identity.status = status;
    body.dataset.authState = status;
    $("#identityLoading").hidden = status !== "unknown" && status !== "checking";
    $("#identityError").hidden = status !== "error";
    updatePreferencesControls();
    if (identity.errorMessage) {
      $("#identityError p").textContent = identity.errorMessage;
    }
  }

  function failPersonalApp(error) {
    console.error("Closeté personal app initialization failed:", error);
    identity.userId = null;
    identity.errorMessage = "بارگذاری کمد ممکن نشد. دوباره تلاش کن.";
    setIdentityStatus("error");
  }

  async function verifyCurrentUser() {
    if (identityRequest) return identityRequest;

    setIdentityStatus("checking");
    identityRequest = (async () => {
      while (true) {
        pendingSessionChange = false;
        let verifiedUserId;
        let requestError = null;
        try {
          const response = await fetch("/api/closet/me/", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            headers: { Accept: "application/json" }
          });
          if (!response.ok || response.redirected) {
            throw new Error("identity-request-failed");
          }

          let payload;
          try {
            payload = await response.json();
          } catch (error) {
            throw new Error("identity-response-invalid");
          }
          if (!isRecord(payload) || !Number.isSafeInteger(payload.id) || payload.id <= 0) {
            throw new Error("identity-response-invalid");
          }
          verifiedUserId = payload.id;
        } catch (error) {
          requestError = error;
        }

        if (pendingSessionChange) continue;

        if (requestError) {
          console.error("Closeté identity verification failed:", requestError);
          identity.userId = null;
          identity.errorMessage = "تأیید هویت انجام نشد. اتصال را بررسی کن و دوباره تلاش کن.";
          setIdentityStatus("error");
          return false;
        }

        if (personalAppInitialized && verifiedUserId !== personalAppUserId) {
          identity.userId = null;
          identity.errorMessage = "تغییر حساب شناسایی شد. برای جلوگیری از نمایش اطلاعات حساب قبلی، فعلاً دسترسی به کمد متوقف شده است.";
          setIdentityStatus("error");
          return false;
        }

        identity.userId = verifiedUserId;
        identity.errorMessage = "";
        if (!personalAppInitialized) personalAppUserId = verifiedUserId;
        setIdentityStatus("ready");
        try {
          if (!personalAppInitialized) initializePersonalApp();
          else {
            refreshAll();
            refreshCalendarForCurrentSession();
            if (!preferencesLoaded && !preferencesLoading) {
              preferencesNeedsRetry = false;
              void fetchUserPreferences();
            }
          }
        } catch (error) {
          failPersonalApp(error);
          return false;
        }
        return true;
      }
    })();

    try {
      return await identityRequest;
    } finally {
      identityRequest = null;
    }
  }

  function receiveSessionChange(event) {
    const message = event.data;
    if (!isRecord(message) || message.type !== "session-changed" ||
        Object.keys(message).length !== 1) return;
    if (identityRequest) {
      pendingSessionChange = true;
      return;
    }

    identity.errorMessage = "";
    void verifyCurrentUser();
  }

  function installIdentityEvents() {
    if (identityEventsInstalled) return;
    identityEventsInstalled = true;

    $("#identityRetry").addEventListener("click", () => {
      void verifyCurrentUser();
    });
    const revalidateWhenVisible = () => {
      if (document.visibilityState !== "hidden") void verifyCurrentUser();
    };
    window.addEventListener("focus", revalidateWhenVisible);
    document.addEventListener("visibilitychange", revalidateWhenVisible);
    window.addEventListener("pageshow", revalidateWhenVisible);

    if (typeof window.BroadcastChannel === "function") {
      try {
        identityChannel = new window.BroadcastChannel("closete-session");
        identityChannel.addEventListener("message", receiveSessionChange);
      } catch (error) {
        console.warn("Closeté cross-tab session notifications are unavailable:", error);
        identityChannel = null;
      }
    }
  }

  function getPalette() {
    const palette = userData.settings.palette;
    return ["neutral", "earth", "dark"].includes(palette) ? palette : "neutral";
  }

  function parsePreferences(payload) {
    if (!isRecord(payload) ||
        !isRecord(payload.style_preferences) ||
        !isRecord(payload.color_preferences)) return null;

    const stylePreferences = payload.style_preferences;
    const colorPreferences = payload.color_preferences;
    const settings = {
      name: Object.prototype.hasOwnProperty.call(stylePreferences, "name")
        ? stylePreferences.name
        : "",
      style: Object.prototype.hasOwnProperty.call(stylePreferences, "style")
        ? stylePreferences.style
        : "مینیمال",
      palette: Object.prototype.hasOwnProperty.call(colorPreferences, "palette")
        ? colorPreferences.palette
        : "neutral"
    };
    if (!isSettingsValid(settings)) return null;
    return {
      settings,
      stylePreferences: { ...stylePreferences },
      colorPreferences: { ...colorPreferences }
    };
  }

  function applyPalette() {
    body.dataset.palette = getPalette();
  }

  let activeCategory = "all";
  let builderCategory = "all";
  let builderSelection = [];
  let builderOutfitId = null;
  let outfitSubmissionInProgress = false;
  let pendingImagePreviewUrl = "";
  let savedGarmentImageUrl = "";
  let imageSelectionVersion = 0;
  let resolvePendingImageValidation = null;
  let pendingImageValidation = Promise.resolve();
  let pendingImageValidationError = "";
  let recommendationSet = [];
  let selectedDate = localDateKey(new Date());
  const todayPersianDate = persianDateParts(new Date());
  let calendarCursor = persianMonthStart(todayPersianDate.year, todayPersianDate.month);
  let toastTimer;

  function updatePreferencesControls() {
    const saveButton = $('#settingsForm button[type="submit"]');
    if (saveButton) {
      saveButton.disabled = !isIdentityReady() ||
        !preferencesLoaded || preferencesLoading || preferencesSaving;
    }
  }

  function setPreferencesStatus(message, isError) {
    const status = $("#settingsForm .settings-intro p");
    status.textContent = message ||
      "تنظیمات به حساب کاربری‌ات متصل است و از سرور دریافت می‌شود.";
    status.setAttribute("role", isError ? "alert" : "status");
    updatePreferencesControls();
  }

  function isCurrentPreferencesRequest(requestId, ownerId) {
    return requestId === preferencesRequestId &&
      isIdentityReady() &&
      identity.userId === ownerId &&
      personalAppUserId === ownerId;
  }

  function deferPreferencesRetry(requestId, ownerId) {
    if (requestId === preferencesRequestId &&
        identity.status === "checking" &&
        identity.userId === ownerId &&
        personalAppUserId === ownerId) {
      preferencesNeedsRetry = true;
    }
  }

  async function fetchUserPreferences() {
    if (!isIdentityReady() || preferencesLoading || preferencesLoaded) return;
    const ownerId = identity.userId;
    preferencesLoading = true;
    const requestId = ++preferencesRequestId;
    setPreferencesStatus("در حال دریافت تنظیمات حساب…", false);

    try {
      const response = await fetch("/api/closet/preferences/", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      if (!response.ok || response.redirected) throw new Error("preferences-request-failed");
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error("preferences-response-invalid");
      }
      const parsed = parsePreferences(payload);
      if (!parsed) throw new Error("preferences-response-invalid");
      if (!isCurrentPreferencesRequest(requestId, ownerId)) {
        deferPreferencesRetry(requestId, ownerId);
        return;
      }

      savedPreferences = parsed;
      userData.settings = parsed.settings;
      preferencesLoaded = true;
      applyPalette();
      renderHeader();
      renderSettings();
      if (recommendationSet.length) generateRecommendations();
      setPreferencesStatus("", false);
    } catch (error) {
      if (!isCurrentPreferencesRequest(requestId, ownerId)) {
        deferPreferencesRetry(requestId, ownerId);
        return;
      }
      console.error("Closeté preferences request failed:", error);
      setPreferencesStatus(
        "تنظیمات حساب بارگیری نشد. اتصال را بررسی کن و دوباره تلاش کن.",
        true
      );
      notify("تنظیمات حساب در دسترس نیست؛ اطلاعات ذخیره‌شده‌ی مرورگر استفاده نمی‌شود.");
    } finally {
      if (requestId === preferencesRequestId) {
        preferencesLoading = false;
        updatePreferencesControls();
        if (preferencesNeedsRetry && isIdentityReady() &&
            identity.userId === ownerId && personalAppUserId === ownerId) {
          preferencesNeedsRetry = false;
          void fetchUserPreferences();
        }
      }
    }
  }

  async function saveUserPreferences(settings) {
    if (!isIdentityReady() || !preferencesLoaded || !savedPreferences ||
        preferencesSaving || !isSettingsValid(settings)) {
      notify("تنظیمات حساب هنوز بارگیری نشده یا در دسترس نیست.");
      return;
    }

    const ownerId = identity.userId;
    const requestId = ++preferencesRequestId;
    preferencesSaving = true;
    updatePreferencesControls();
    try {
      const csrfToken = getCsrfToken();
      if (!csrfToken) throw new Error("csrf-token-missing");
      const response = await fetch("/api/closet/preferences/", {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRFToken": csrfToken
        },
        body: JSON.stringify({
          style_preferences: {
            ...savedPreferences.stylePreferences,
            name: settings.name,
            style: settings.style
          },
          color_preferences: {
            ...savedPreferences.colorPreferences,
            palette: settings.palette
          }
        })
      });
      if (!response.ok || response.redirected) throw new Error("preferences-update-failed");
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error("preferences-response-invalid");
      }
      const parsed = parsePreferences(payload);
      if (!parsed) throw new Error("preferences-response-invalid");
      if (!isCurrentPreferencesRequest(requestId, ownerId)) return;

      savedPreferences = parsed;
      userData.settings = parsed.settings;
      applyPalette();
      renderHeader();
      renderSettings();
      if (recommendationSet.length) generateRecommendations();
      setPreferencesStatus("", false);
      notify("تنظیمات حساب ذخیره شد.");
    } catch (error) {
      if (!isCurrentPreferencesRequest(requestId, ownerId)) return;
      console.error("Closeté preferences update failed:", error);
      setPreferencesStatus(error.message === "csrf-token-missing"
        ? "نشانه‌ی امنیتی درخواست پیدا نشد؛ صفحه را تازه‌سازی کن."
        : "ذخیره‌ی تنظیمات انجام نشد؛ تغییرات ثبت نشده‌اند.", true);
      renderSettings();
      notify(error.message === "csrf-token-missing"
        ? "نشانه‌ی امنیتی درخواست پیدا نشد؛ صفحه را تازه‌سازی و دوباره تلاش کن."
        : "ذخیره‌ی تنظیمات انجام نشد؛ تنظیمات قبلی حفظ شدند.");
    } finally {
      if (requestId === preferencesRequestId) {
        preferencesSaving = false;
        updatePreferencesControls();
      }
    }
  }

  function notify(message) {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2800);
  }

  function garmentById(garmentId) {
    const id = Number(garmentId);
    return serverWardrobe.garments.find(garment => garment.id === id);
  }

  function serverGarmentById(garmentId) {
    const id = Number(garmentId);
    return serverWardrobe.garments.find(garment => garment.id === id) ||
      serverWardrobe.archivedGarments.find(garment => garment.id === id);
  }

  function serverOutfitById(outfitId) {
    return serverOutfits.outfits.find(outfit => outfit.id === Number(outfitId));
  }

  function calendarDataReady() {
    return serverCalendar.status === "ready" && serverOutfits.status === "ready" &&
      (!serverCalendar.plans.length || serverCalendar.ownerId !== null) &&
      (!serverOutfits.outfits.length || serverOutfits.ownerId !== null) &&
      !(serverCalendar.ownerId !== null && serverOutfits.ownerId !== null &&
        serverCalendar.ownerId !== serverOutfits.ownerId);
  }

  function calendarPlanForDate(dateKey) {
    const gregorianDate = persianDateToGregorianISO(dateKey);
    if (!gregorianDate) return null;
    return serverCalendar.plans.find(plan => plan.date === gregorianDate) || null;
  }

  function imageTag(source, alt, extraClass) {
    return `<img class="${extraClass || ""}" src="${escapeHTML(source || defaultImage)}" alt="${escapeHTML(alt || "")}" loading="lazy" onerror="this.onerror=null;this.src='${defaultImage}'">`;
  }

  function setActiveView(view, updateHash, focusMain) {
    if (!isIdentityReady()) return;
    const target = $(`[data-page="${view}"]`);
    if (!target) view = "dashboard";
    $$(".app-view").forEach(section => {
      const active = section.dataset.page === view;
      section.hidden = !active;
      section.classList.toggle("is-visible", active);
    });
    $$(".side-link[data-view]").forEach(button => button.classList.toggle("is-active", button.dataset.view === view));
    setSidebarOpen(false, focusMain ? $("#appMain") : null);
    if (updateHash && window.location.hash.slice(1) !== view) window.location.hash = view;
    if (view === "wardrobe") {
      renderWardrobe();
      if (wardrobeMode === "server" && serverWardrobe.status === "idle") fetchServerGarments();
    }
    if (view === "outfits") {
      renderOutfits();
      if (outfitSource === "server" && serverOutfits.status === "idle") fetchServerOutfits();
    }
    if (view === "builder") renderBuilder();
    if (view === "calendar") {
      renderCalendar();
      if (serverCalendar.status === "idle" || serverOutfits.status === "idle") {
        refreshCalendarData(false);
      }
    }
    if (view === "settings") renderSettings();
    if (view === "stylist" && !recommendationSet.length) generateRecommendations();
  }

  function setSidebarOpen(isOpen, focusTarget) {
    const sidebar = $("#appSidebar");
    const menuButton = $("#mobileMenu");
    const backdrop = $("#sidebarBackdrop");
    const wasOpen = sidebar.classList.contains("is-open");

    if (!isOpen && wasOpen &&
        (sidebar.contains(document.activeElement) || backdrop === document.activeElement)) {
      (focusTarget || menuButton).focus();
    }

    if (isOpen && previousScrollOverflow === null) {
      previousScrollOverflow = {
        html: document.documentElement.style.overflow,
        body: body.style.overflow
      };
      document.documentElement.style.overflow = "hidden";
      body.style.overflow = "hidden";
    } else if (!isOpen && previousScrollOverflow !== null) {
      document.documentElement.style.overflow = previousScrollOverflow.html;
      body.style.overflow = previousScrollOverflow.body;
      previousScrollOverflow = null;
    }

    sidebar.inert = !isOpen;
    sidebar.classList.toggle("is-open", isOpen);
    menuButton.setAttribute("aria-expanded", String(isOpen));
    menuButton.setAttribute("aria-label", isOpen ? "بستن منو" : "باز کردن منو");
    backdrop.classList.toggle("is-visible", isOpen);
    backdrop.setAttribute("aria-hidden", String(!isOpen));

    if (isOpen) {
      const firstLink = sidebar.querySelector(".side-nav a, .side-nav button, .sidebar-bottom a, .sidebar-bottom button");
      if (firstLink) firstLink.focus();
    }
  }

  function categoryFilterMarkup(selected, includeAll) {
    const list = includeAll ? [["all", "همه"]] : [];
    categories.forEach(key => list.push([key, categoryNames[key]]));
    return list.map(([key, label]) =>
      `<button type="button" class="${includeAll ? "filter-chip" : "builder-category"}${selected === key ? " is-active" : ""}" data-category="${key}">${label}</button>`
    ).join("");
  }

  function renderHeader() {
    if (!isIdentityReady()) return;
    const name = (preferencesLoaded && userData.settings.name) || "دوست من";
    $("#welcomeName").textContent = "سلام، " + name;
    $("#avatarInitial").textContent = name.trim().charAt(0) || "م";
    $("#welcomeEyebrow").textContent = new Intl.DateTimeFormat("en", { weekday: "long" }).format(new Date()).toUpperCase() + ", YOUR WAY";
    $("#todayLabel").textContent = new Intl.DateTimeFormat("fa-IR", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
    $("#todayDate").textContent = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
    $("#navGarmentCount").textContent = faNumber(serverWardrobe.garments.length);
  }

  function renderDashboard() {
    if (!isIdentityReady()) return;
    $("#metricGarments").textContent = faNumber(serverWardrobe.garments.length);
    $("#metricOutfits").textContent = faNumber(serverOutfits.outfits.length);
    $("#metricFavorites").textContent = faNumber(serverWardrobe.garments.filter(item => item.favorite).length);
    const mix = serverWardrobe.garments.filter(item => ["tops", "trousers", "shoes"].includes(item.category)).slice(0, 3);
    $("#todayCollage").innerHTML = mix.length
      ? mix.map(item => imageTag(item.image, item.name)).join("")
      : `<div class="empty-inline">لباس اضافه کن تا استایل امروزت را ببینی.</div>`;
    $("#todayOutfitText").textContent = mix.length >= 2
      ? mix.map(item => item.name).join(" · ")
      : "چند لباس به کمدت اضافه کن تا ترکیب امروز آماده شود.";

    const recent = [...serverWardrobe.garments].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, 3);
    $("#recentGarments").innerHTML = recent.length ? recent.map(item =>
      `<article class="recent-item">${imageTag(item.image, item.name)}<strong>${escapeHTML(item.name)}</strong><small>${categoryNames[item.category] || "لباس"} · ${escapeHTML(item.color)}</small></article>`
    ).join("") : `<div class="empty-inline">هنوز لباسی در کمدت نیست.</div>`;
    if (!calendarDataReady()) {
      $("#upcomingPlans").innerHTML = serverCalendar.status === "error" || serverOutfits.status === "error"
        ? `<div class="empty-inline">دریافت برنامه‌های تقویم ممکن نشد.<br><button type="button" class="text-action" data-action="retry-calendar">تلاش دوباره</button></div>`
        : `<div class="empty-inline">در حال دریافت برنامه‌های تقویم…</div>`;
      return;
    }
    const today = persianDateToGregorianISO(localDateKey(new Date()));
    const upcoming = serverCalendar.plans
      .filter(plan => plan.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 2);
    $("#upcomingPlans").innerHTML = upcoming.length ? upcoming.map(plan => {
      const outfit = serverOutfitById(plan.outfit);
      const day = gregorianISOToPersianKey(plan.date);
      if (!day) return "";
      const firstGarment = outfit && outfit.garments.length
        ? outfit.garments.slice().sort((a, b) => a.order - b.order)[0].garment_details
        : null;
      const image = firstGarment && firstGarment.image
        ? new URL(firstGarment.image, window.location.href).href
        : "";
      return `<div class="plan-preview"><span class="plan-date-chip">${escapeHTML(new Intl.DateTimeFormat("fa-IR-u-ca-persian", { day: "numeric", month: "short" }).format(dateFromKey(day)))}</span>${image ? imageTag(image, outfit.name) : ""}<span><strong>${escapeHTML(outfit ? outfit.name : "استایل در دسترس نیست")}</strong><small>${escapeHTML(outfit ? outfit.occasion || "استایل برنامه‌ریزی‌شده" : "برنامه‌ی ذخیره‌شده")}</small></span></div>`;
    }).join("") : `<div class="empty-inline">هنوز استایلی برای روزهای آینده نچیده‌ای.<br><button type="button" class="text-action" data-view="calendar">برنامه‌ریزی یک استایل ←</button></div>`;
  }

  function isServerGarment(item) {
    return isRecord(item) &&
      Number.isInteger(item.id) &&
      typeof item.name === "string" &&
      typeof item.category === "string" &&
      typeof item.color === "string" &&
      typeof item.season === "string" &&
      typeof item.is_archived === "boolean" &&
      (typeof item.image === "string" || item.image === null);
  }

  async function fetchGarmentList(url, archived) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    if (response.status === 401 || response.status === 403 || response.redirected) {
      throw new Error("auth");
    }
    if (response.status === 404) throw new Error("not-found");
    if (response.status === 400) throw new Error("bad-request");
    if (!response.ok) throw new Error("server");

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error("invalid-response");
    }
    if (!Array.isArray(payload) || !payload.every(item =>
      isServerGarment(item) && item.is_archived === archived
    )) {
      throw new Error("invalid-response");
    }
    return payload;
  }

  function fetchServerGarments() {
    if (!isIdentityReady()) return Promise.resolve();
    if (serverWardrobe.status === "loading") return serverWardrobeRequest;
    serverWardrobe.status = "loading";
    serverWardrobe.error = "";
    renderWardrobe();

    serverWardrobeRequest = Promise.all([
      fetchGarmentList("/api/closet/garments/", false),
      fetchGarmentList("/api/closet/garments/?archived=true", true)
    ]).then(([garments, archivedGarments]) => {
      serverWardrobe.garments = garments;
      serverWardrobe.archivedGarments = archivedGarments;
      serverWardrobe.status = "ready";
      const builderView = $('[data-page="builder"]');
      if (builderView && !builderView.hidden) renderBuilder();
    }).catch(error => {
      console.error("Closeté server wardrobe request failed:", error);
      serverWardrobe.status = "error";
      if (error.message === "auth") {
        serverWardrobe.error = "برای دیدن کمد سرور باید دوباره وارد حساب کاربری شوی.";
      } else if (error.message === "invalid-response") {
        serverWardrobe.error = "پاسخ کمد سرور قابل‌خواندن نیست.";
      } else if (error.message === "not-found" || error.message === "bad-request") {
        serverWardrobe.error = "دریافت بخش آرشیو کمد ممکن نشد. کمی بعد دوباره تلاش کن.";
      } else if (error.message === "server") {
        serverWardrobe.error = "دریافت کمد سرور ناموفق بود. کمی بعد دوباره تلاش کن.";
      } else {
        serverWardrobe.error = "ارتباط با کمد سرور برقرار نشد؛ اتصال شبکه را بررسی کن.";
      }
    }).finally(() => {
      serverWardrobeRequest = null;
      renderHeader();
      renderDashboard();
      renderWardrobe();
    }).catch(error => {
      failPersonalApp(error);
    });
    return serverWardrobeRequest;
  }

  function renderWardrobe() {
    if (!isIdentityReady()) return;
    const showingLegacy = wardrobeMode === "legacy";
    $("#legacyWardrobeContent").hidden = !showingLegacy;
    $("#serverArchivedSection").hidden = showingLegacy || serverWardrobe.status !== "ready";
    $("#serverWardrobeStatus").hidden = showingLegacy ||
      (serverWardrobe.status === "ready" && serverWardrobe.garments.length > 0);
    $("#serverGarmentGrid").hidden = showingLegacy || serverWardrobe.status !== "ready" || !serverWardrobe.garments.length;
    $$("[data-wardrobe-mode]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.wardrobeMode === wardrobeMode));
    });

    if (!showingLegacy) {
      const status = $("#serverWardrobeStatus");
      status.className = "server-wardrobe-status";
      if (serverWardrobe.status === "idle" || serverWardrobe.status === "loading") {
        status.textContent = "در حال دریافت لباس‌های کمد سرور…";
        status.dataset.state = "loading";
      } else if (serverWardrobe.status === "error") {
        status.textContent = serverWardrobe.error;
        status.dataset.state = "error";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "button button-quiet";
        retry.dataset.action = "retry-server-wardrobe";
        retry.textContent = "تلاش دوباره";
        status.appendChild(retry);
      } else if (!serverWardrobe.garments.length) {
        status.textContent = "هنوز لباسی در کمد سرور ثبت نشده است.";
        status.dataset.state = "empty";
      } else {
        status.textContent = "";
      }

      $("#serverGarmentGrid").innerHTML = serverWardrobe.garments.map(item => {
        const image = item.image ? new URL(item.image, window.location.href).href : defaultImage;
        const pending = pendingGarmentUpdates.has(item.id);
        const deleting = pendingGarmentDeletes.has(item.id);
        return `<article class="garment-card">
          <div class="garment-image">${imageTag(image, item.name)}
            <div class="card-menu"><button type="button" data-action="edit-garment" data-id="${item.id}" aria-label="ویرایش ${escapeHTML(item.name)}" ${pending ? "disabled aria-busy=\"true\"" : ""}>ویرایش</button><button type="button" data-action="archive-garment" data-id="${item.id}" aria-label="آرشیو کردن ${escapeHTML(item.name)}" ${pending ? "disabled aria-busy=\"true\"" : ""}>${pending ? "در حال…" : "آرشیو"}</button><button type="button" data-action="delete-garment" data-id="${item.id}" aria-label="حذف دائمی ${escapeHTML(item.name)}" title="حذف دائمی" ${pending ? "disabled aria-busy=\"true\"" : ""}>${deleting ? "در حال حذف…" : "حذف"}</button></div>
          </div><div class="garment-info"><h3>${escapeHTML(item.name)}</h3><div class="garment-meta"><span>${escapeHTML(item.color || "")} · ${escapeHTML(categoryNames[item.category] || item.category || "لباس")}</span><span class="garment-tag">${escapeHTML(item.season || "چهارفصل")}</span></div></div>
        </article>`;
      }).join("");

      const archivedStatus = $("#serverArchivedStatus");
      const archivedGrid = $("#serverArchivedGrid");
      archivedStatus.hidden = serverWardrobe.archivedGarments.length > 0;
      archivedStatus.textContent = serverWardrobe.archivedGarments.length
        ? ""
        : "هنوز لباسی را آرشیو نکرده‌ای.";
      archivedGrid.hidden = serverWardrobe.archivedGarments.length === 0;
      archivedGrid.innerHTML = serverWardrobe.archivedGarments.map(item => {
        const image = item.image ? new URL(item.image, window.location.href).href : defaultImage;
        const pending = pendingGarmentUpdates.has(item.id);
        const deleting = pendingGarmentDeletes.has(item.id);
        return `<article class="garment-card">
          <div class="garment-image">${imageTag(image, item.name)}
            <div class="card-menu"><button type="button" data-action="edit-garment" data-id="${item.id}" aria-label="ویرایش ${escapeHTML(item.name)}" ${pending ? "disabled aria-busy=\"true\"" : ""}>ویرایش</button><button type="button" data-action="restore-garment" data-id="${item.id}" aria-label="بازگردانی ${escapeHTML(item.name)}" ${pending ? "disabled aria-busy=\"true\"" : ""}>${pending ? "در حال…" : "بازگردانی"}</button><button type="button" data-action="delete-garment" data-id="${item.id}" aria-label="حذف دائمی ${escapeHTML(item.name)}" title="حذف دائمی" ${pending ? "disabled aria-busy=\"true\"" : ""}>${deleting ? "در حال حذف…" : "حذف"}</button></div>
          </div><div class="garment-info"><h3>${escapeHTML(item.name)}</h3><div class="garment-meta"><span>${escapeHTML(item.color || "")} · ${escapeHTML(categoryNames[item.category] || item.category || "لباس")}</span><span class="garment-tag">${escapeHTML(item.season || "چهارفصل")}</span></div></div>
        </article>`;
      }).join("");
      return;
    }

    $("#categoryFilters").innerHTML = categoryFilterMarkup(activeCategory, true);
    const query = $("#garmentSearch").value.trim().toLocaleLowerCase("fa");
    const color = $("#colorFilter").value;
    const season = $("#seasonFilter").value;
    const occasion = $("#occasionFilter").value;
    const sort = $("#sortGarments").value;
    let items = state.garments.filter(item =>
      (activeCategory === "all" || item.category === activeCategory) &&
      (!query || `${item.name} ${item.color} ${categoryNames[item.category]}`.toLocaleLowerCase("fa").includes(query)) &&
      (!color || item.color === color) && (!season || item.season === season) && (!occasion || item.occasion === occasion)
    );
    if (sort === "name") items.sort((a, b) => a.name.localeCompare(b.name, "fa"));
    else if (sort === "favorites") items.sort((a, b) => Number(b.favorite) - Number(a.favorite));
    else items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    $("#garmentResults").textContent = `${faNumber(items.length)} لباس`;
    const active = [];
    if (activeCategory !== "all") active.push(categoryNames[activeCategory]);
    if (color) active.push(color);
    if (season) active.push(season);
    if (occasion) active.push(occasion);
    if (query) active.push(`«${query}»`);
    $("#activeFilters").textContent = active.length ? "فیلترهای فعال: " + active.join("، ") : "";
    $("#legacyGarmentGrid").innerHTML = items.length ? items.map(item => `
      <article class="garment-card">
        <div class="garment-image">${imageTag(item.image, item.name)}
        </div><div class="garment-info"><h3>${escapeHTML(item.name)}</h3><div class="garment-meta"><span>${escapeHTML(item.color)} · ${categoryNames[item.category] || "لباس"}</span><span class="garment-tag">${escapeHTML(item.season || "چهارفصل")}</span></div></div>
      </article>`).join("") : `<div class="empty-state"><span>◫</span><h3>${state.garments.length ? "چیزی با این مشخصات پیدا نشد." : "کمد قدیمی خالی است."}</h3><p>${state.garments.length ? "فیلترها را پاک کن یا با یک جست‌وجوی دیگر امتحان کن." : "اطلاعات قدیمی فقط برای مشاهده نگه‌داری می‌شوند."}</p>${state.garments.length ? `<button type="button" class="button button-quiet" id="emptyClearFilters">پاک کردن فیلترها</button>` : ""}</div>`;
  }

  function getCsrfToken() {
      const cookie = document.cookie.split(";").map(value => value.trim())
        .find(value => value.startsWith("csrftoken="));
      if (!cookie) {
        return $('input[name="csrfmiddlewaretoken"]', $("#garmentForm"))?.value || "";
      }
      try {
        return decodeURIComponent(cookie.slice("csrftoken=".length));
      } catch (error) {
        return $('input[name="csrfmiddlewaretoken"]', $("#garmentForm"))?.value || "";
      }
  }

  async function updateGarmentArchive(garmentId, archived) {
      if (pendingGarmentUpdates.has(garmentId)) return;
      const csrfToken = getCsrfToken();
      if (!csrfToken) {
        notify("نشانه‌ی امنیتی درخواست پیدا نشد؛ صفحه را تازه‌سازی و دوباره تلاش کن.");
        return;
      }

      pendingGarmentUpdates.add(garmentId);
      renderWardrobe();
      try {
        const response = await fetch(`/api/closet/garments/${garmentId}/`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-CSRFToken": csrfToken
          },
          body: JSON.stringify({ is_archived: archived })
        });

        if (response.status === 401) throw new Error("auth");
        if (response.status === 403) throw new Error("forbidden");
        if (response.status === 404) throw new Error("not-found");
        if (response.status === 400) throw new Error("bad-request");
        if (response.redirected) throw new Error("auth");
        if (!response.ok) throw new Error("server");

        let updatedGarment;
        try {
          updatedGarment = await response.json();
        } catch (error) {
          throw new Error("invalid-response");
        }
        if (!isServerGarment(updatedGarment) ||
            updatedGarment.id !== garmentId ||
            updatedGarment.is_archived !== archived) {
          throw new Error("invalid-response");
        }

        serverWardrobe.garments = serverWardrobe.garments.filter(item => item.id !== garmentId);
        serverWardrobe.archivedGarments = serverWardrobe.archivedGarments
          .filter(item => item.id !== garmentId);
        if (archived) serverWardrobe.archivedGarments.push(updatedGarment);
        else serverWardrobe.garments.push(updatedGarment);

        serverOutfits.outfits.forEach(outfit => {
          outfit.garments.forEach(link => {
            if (link.garment === garmentId) {
              link.garment_details = { ...link.garment_details, is_archived: archived };
            }
          });
        });
        renderHeader();
        renderDashboard();
        renderOutfits();
        notify(archived ? "لباس به آرشیو منتقل شد." : "لباس از آرشیو بازگردانده شد.");
      } catch (error) {
        console.error("Closeté garment archive request failed:", error);
        if (error.message === "auth") {
          notify("نشست کاربری معتبر نیست؛ دوباره وارد حساب کاربری شو.");
        } else if (error.message === "forbidden") {
          notify("درخواست رد شد؛ نشانه‌ی امنیتی یا نشست کاربری معتبر نیست.");
        } else if (error.message === "not-found") {
          notify("این لباس دیگر در کمدت پیدا نمی‌شود.");
        } else if (error.message === "bad-request") {
          notify("درخواست آرشیو معتبر نیست؛ کمد با سرور همگام نشد.");
        } else if (error.message === "invalid-response") {
          notify("پاسخ سرور معتبر نبود؛ وضعیت کمد تغییر نکرد.");
        } else if (error.message === "server") {
          notify("سرور نتوانست وضعیت لباس را تغییر دهد؛ دوباره تلاش کن.");
        } else {
          notify("ارتباط با سرور برقرار نشد؛ وضعیت کمد تغییر نکرد.");
        }
      } finally {
        pendingGarmentUpdates.delete(garmentId);
        renderWardrobe();
      }
  }

  function isServerOutfitPayload(payload) {
    return Array.isArray(payload) && payload.every(outfit =>
      isRecord(outfit) &&
      Number.isInteger(outfit.id) &&
      Number.isInteger(outfit.owner) &&
      typeof outfit.name === "string" &&
      typeof outfit.occasion === "string" &&
      typeof outfit.season === "string" &&
      Array.isArray(outfit.garments) &&
      outfit.garments.every(link =>
        isRecord(link) &&
        Number.isInteger(link.garment) &&
        typeof link.role === "string" &&
        Number.isInteger(link.order) &&
        isRecord(link.garment_details) &&
        link.garment_details.id === link.garment &&
        typeof link.garment_details.name === "string" &&
        typeof link.garment_details.category === "string" &&
        typeof link.garment_details.color === "string" &&
        typeof link.garment_details.season === "string" &&
        typeof link.garment_details.is_archived === "boolean" &&
        (typeof link.garment_details.image === "string" || link.garment_details.image === null)
      )
    );
  }

  function serverOutfitOwnerId(outfits) {
    if (!outfits.length) return null;
    const ownerId = outfits[0].owner;
    return Number.isInteger(ownerId) &&
      outfits.every(outfit => outfit.owner === ownerId)
      ? ownerId
      : null;
  }

  function isServerCalendarPayload(payload) {
    return Array.isArray(payload) && payload.every(plan =>
      isRecord(plan) &&
      Number.isInteger(plan.id) &&
      Number.isInteger(plan.owner) &&
      /^\d{4}-\d{2}-\d{2}$/.test(plan.date) &&
      gregorianISOToPersianKey(plan.date) !== null &&
      Number.isInteger(plan.outfit) &&
      typeof plan.created_at === "string" &&
      typeof plan.updated_at === "string"
    ) && new Set(payload.map(plan => plan.date)).size === payload.length &&
      new Set(payload.map(plan => plan.owner)).size <= 1;
  }

  function currentCalendarOutfits() {
    if (serverOutfits.outfits.length && serverOutfits.ownerId === null) return [];
    const ownerId = serverCalendar.ownerId !== null
      ? serverCalendar.ownerId
      : serverOutfits.ownerId;
    if (ownerId === null) return serverOutfits.outfits;
    return serverOutfits.outfits.filter(outfit => outfit.owner === ownerId);
  }

  function fetchServerOutfits(force) {
    if (!isIdentityReady()) return Promise.resolve([]);
    if (serverOutfitsRequest) return serverOutfitsRequest;
    if (!force && serverOutfits.status === "ready") {
      return Promise.resolve(serverOutfits.outfits);
    }
    const requestSessionVersion = calendarSessionVersion;
    const requestDataVersion = serverOutfitsDataVersion;
    serverOutfits.status = "loading";
    serverOutfits.error = "";
    renderOutfits();

    serverOutfitsRequest = fetch("/api/closet/outfits/", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" }
    }).then(async response => {
      if (response.status === 401 || response.status === 403 || response.redirected) {
        throw new Error("auth");
      }
      if (!response.ok) throw new Error("server");

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error("invalid-response");
      }
      if (!isServerOutfitPayload(payload)) throw new Error("invalid-response");
      if (requestSessionVersion !== calendarSessionVersion ||
          requestDataVersion !== serverOutfitsDataVersion) return;

      serverOutfits.outfits = payload;
      serverOutfits.ownerId = serverOutfitOwnerId(payload);
      serverOutfits.status = "ready";
    }).catch(error => {
      if (requestSessionVersion !== calendarSessionVersion ||
          requestDataVersion !== serverOutfitsDataVersion) return;
      console.error("Closeté server outfits request failed:", error);
      serverOutfits.status = "error";
      if (error.message === "auth") {
        serverOutfits.outfits = [];
        serverOutfits.ownerId = null;
        serverOutfits.error = "برای دیدن استایل‌های سرور باید دوباره وارد حساب کاربری شوی.";
      } else if (error.message === "invalid-response") {
        serverOutfits.error = "پاسخ استایل‌های سرور قابل‌خواندن نیست.";
      } else if (error.message === "server") {
        serverOutfits.error = "دریافت استایل‌های سرور ناموفق بود. کمی بعد دوباره تلاش کن.";
      } else {
        serverOutfits.error = "ارتباط با استایل‌های سرور برقرار نشد؛ اتصال شبکه را بررسی کن.";
      }
    }).finally(() => {
      serverOutfitsRequest = null;
      renderOutfits();
      renderCalendar();
      renderDashboard();
      if (requestSessionVersion !== calendarSessionVersion && serverOutfits.status === "idle") {
        fetchServerOutfits(true);
      }
    }).catch(error => {
      failPersonalApp(error);
    });
    return serverOutfitsRequest;
  }

  function fetchServerCalendar(force) {
    if (!isIdentityReady()) return Promise.resolve([]);
    if (serverCalendarRequest) return serverCalendarRequest;
    if (!force && serverCalendar.status === "ready") {
      return Promise.resolve(serverCalendar.plans);
    }
    const requestSessionVersion = calendarSessionVersion;
    serverCalendar.status = "loading";
    serverCalendar.error = "";
    renderCalendar();
    renderDashboard();

    serverCalendarRequest = fetch("/api/closet/calendar/", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" }
    }).then(async response => {
      if (response.status === 401 || response.status === 403 || response.redirected) {
        throw new Error("auth");
      }
      if (!response.ok) throw new Error("server");

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error("invalid-response");
      }
      if (!isServerCalendarPayload(payload)) throw new Error("invalid-response");
      if (requestSessionVersion !== calendarSessionVersion) return;

      serverCalendar.plans = payload;
      serverCalendar.ownerId = payload.length ? payload[0].owner : null;
      serverCalendar.status = "ready";
    }).catch(error => {
      if (requestSessionVersion !== calendarSessionVersion) return;
      console.error("Closeté server calendar request failed:", error);
      serverCalendar.status = "error";
      if (error.message === "auth") {
        serverCalendar.plans = [];
        serverCalendar.ownerId = null;
        serverCalendar.error = "برای دیدن تقویم سرور باید دوباره وارد حساب کاربری شوی.";
      } else if (error.message === "invalid-response") {
        serverCalendar.error = "پاسخ تقویم سرور قابل‌خواندن نیست.";
      } else if (error.message === "server") {
        serverCalendar.error = "دریافت تقویم سرور ناموفق بود. کمی بعد دوباره تلاش کن.";
      } else {
        serverCalendar.error = "ارتباط با تقویم سرور برقرار نشد؛ اتصال شبکه را بررسی کن.";
      }
    }).finally(() => {
      serverCalendarRequest = null;
      renderCalendar();
      renderDashboard();
      if (requestSessionVersion !== calendarSessionVersion && serverCalendar.status === "idle") {
        fetchServerCalendar(true);
      }
    }).catch(error => {
      failPersonalApp(error);
    });
    return serverCalendarRequest;
  }

  function validateCalendarOwner() {
    if (
      (serverOutfits.outfits.length && serverOutfits.ownerId === null) ||
      (serverCalendar.plans.length && serverCalendar.ownerId === null) ||
      (serverOutfits.ownerId !== null && serverCalendar.ownerId !== null &&
        serverOutfits.ownerId !== serverCalendar.ownerId)
    ) {
      serverCalendar.status = "error";
      serverCalendar.error = "مالکیت استایل‌ها و برنامه‌های تقویم با هم سازگار نیست؛ دوباره دریافت کن.";
      return false;
    }
    return true;
  }

  function refreshCalendarData(force) {
    if (!isIdentityReady()) return Promise.resolve();
    const requestSessionVersion = calendarSessionVersion;
    return Promise.all([
      fetchServerOutfits(force),
      fetchServerCalendar(force)
    ]).then(() => {
      if (requestSessionVersion !== calendarSessionVersion) {
        return refreshCalendarData(true);
      }
      if (serverOutfits.status === "ready" && serverCalendar.status === "ready") {
        validateCalendarOwner();
      }
      renderCalendar();
      renderDashboard();
    }).catch(error => {
      failPersonalApp(error);
    });
  }

  function resetCalendarSessionData() {
    calendarSessionVersion += 1;
    pendingCalendarDates.clear();
    serverCalendar.plans = [];
    serverCalendar.ownerId = null;
    serverCalendar.status = "idle";
    serverCalendar.error = "";
    serverOutfits.outfits = [];
    serverOutfits.ownerId = null;
    serverOutfits.status = "idle";
    serverOutfits.error = "";
    renderCalendar();
    renderDashboard();
    renderOutfits();
  }

  function outfitImages(outfit, max) {
    const items = outfit.items.map(garmentById).filter(Boolean).slice(0, max || 3);
    return items.length ? items.map(item => imageTag(item.image, item.name)).join("") : `<div class="empty-inline">لباس‌های این ترکیب دیگر در کمد نیستند.</div>`;
  }

  function renderOutfits() {
    if (!isIdentityReady()) return;
    $("#outfitGrid").innerHTML = state.outfits.length ? state.outfits.map(outfit => `
      <article class="outfit-card"><div class="outfit-card-images">${outfitImages(outfit)}</div><div class="outfit-card-body"><h3>${escapeHTML(outfit.name)}</h3><div class="outfit-card-meta"><span>${escapeHTML(outfit.occasion || "بدون مناسبت")}</span><span>${escapeHTML(outfit.season || "چهارفصل")}</span><span>${faNumber(outfit.items.filter(garmentById).length)} قطعه</span></div><small class="legacy-readonly-label">استایل قدیمی · فقط‌خواندنی</small></div></article>`
    ).join("") : `<div class="empty-state"><span>◈</span><h3>هنوز استایلی ذخیره نکرده‌ای.</h3><p>چند لباس را کنار هم بگذار و ترکیب دلخواهت را برای بعد نگه دار.</p><button type="button" class="button button-primary" data-view="builder">ساخت استایل</button></div>`;

    const showingLegacy = outfitSource === "legacy";
    $("#legacyOutfitContent").hidden = !showingLegacy;
    $("#serverOutfitContent").hidden = showingLegacy;
    $$("[data-outfit-source]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.outfitSource === outfitSource));
    });

    const status = $("#serverOutfitStatus");
    const grid = $("#serverOutfitGrid");
    grid.hidden = serverOutfits.status !== "ready" || !serverOutfits.outfits.length;
    status.hidden = serverOutfits.status === "ready" && serverOutfits.outfits.length > 0;
    status.className = "server-outfit-status";
    if (serverOutfits.status === "idle" || serverOutfits.status === "loading") {
      status.textContent = "در حال دریافت استایل‌های سرور…";
      status.dataset.state = "loading";
    } else if (serverOutfits.status === "error") {
      status.textContent = serverOutfits.error;
      status.dataset.state = "error";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "button button-quiet";
      retry.dataset.action = "retry-server-outfits";
      retry.textContent = "تلاش دوباره";
      status.appendChild(retry);
    } else if (!serverOutfits.outfits.length) {
      status.textContent = "هنوز استایلی در کمد سرور ثبت نشده است.";
      status.dataset.state = "empty";
    } else {
      status.textContent = "";
      status.dataset.state = "ready";
    }

    grid.innerHTML = serverOutfits.outfits.map(outfit => {
      const deleting = pendingOutfitDeletes.has(outfit.id);
      const garments = outfit.garments.slice().sort((a, b) => a.order - b.order);
      const imageMarkup = garments.length
        ? garments.slice(0, 3).map(link => {
          const garment = link.garment_details;
          const image = garment.image ? new URL(garment.image, window.location.href).href : defaultImage;
          return imageTag(image, garment.name);
        }).join("")
        : `<div class="empty-inline">لباسی برای این استایل ثبت نشده است.</div>`;
      const garmentMarkup = garments.length
        ? garments.map(link => {
          const garment = link.garment_details;
          const archiveLabel = garment.is_archived
            ? `<span class="archived-garment-badge">آرشیوشده</span>`
            : "";
          return `<li class="server-outfit-garment${garment.is_archived ? " is-archived" : ""}">
            <span class="server-outfit-garment-name">${escapeHTML(garment.name)}</span>
            <span class="server-outfit-garment-meta">${escapeHTML(garment.color || "بدون رنگ")} · ${escapeHTML(categoryNames[garment.category] || garment.category)}${garment.season ? ` · ${escapeHTML(garment.season)}` : ""}</span>
            ${archiveLabel}
          </li>`;
        }).join("")
        : "";
      return `<article class="outfit-card server-outfit-card">
        <div class="outfit-card-images">${imageMarkup}</div>
        <div class="outfit-card-body">
          <h3>${escapeHTML(outfit.name)}</h3>
          <div class="outfit-card-meta"><span>${escapeHTML(outfit.occasion || "بدون مناسبت")}</span><span>${escapeHTML(outfit.season || "چهارفصل")}</span><span>${faNumber(garments.length)} قطعه</span></div>
          <ul class="server-outfit-garments">${garmentMarkup}</ul>
          <div class="outfit-card-actions">
            <button type="button" data-action="edit-outfit" data-id="${outfit.id}" aria-label="ویرایش ${escapeHTML(outfit.name)}" ${deleting || outfitSubmissionInProgress ? "disabled" : ""}>ویرایش</button>
            <button type="button" data-action="delete-outfit" data-id="${outfit.id}" aria-label="حذف ${escapeHTML(outfit.name)}" ${deleting || outfitSubmissionInProgress ? "disabled" : ""}>${deleting ? "در حال حذف…" : "حذف"}</button>
          </div>
        </div>
      </article>`;
    }).join("");
  }

  function startBuilder(outfitId) {
    const outfit = outfitId ? serverOutfitById(outfitId) : null;
    if (outfitId && !outfit) {
      notify("این استایل دیگر در کمد سرور پیدا نمی‌شود؛ فهرست را تازه‌سازی کن.");
      void fetchServerOutfits(true);
      return;
    }
    builderOutfitId = outfit ? outfit.id : null;
    builderSelection = outfit
      ? outfit.garments.slice().sort((a, b) => a.order - b.order)
        .filter(link => !link.garment_details.is_archived)
        .map(link => link.garment)
      : [];
    builderCategory = "all";
    $("#builderHeading").textContent = outfit ? "ویرایش استایل" : "ساخت یک استایل تازه";
    $("#outfitName").value = outfit ? outfit.name : "";
    $("#outfitOccasion").value = outfit ? outfit.occasion || "" : "";
    $("#outfitSeason").value = outfit ? outfit.season || "" : "";
    setActiveView("builder", true);
  }

  function renderBuilder() {
    if (!isIdentityReady()) return;
    if (serverWardrobe.status === "ready") {
      builderSelection = builderSelection
        .map(garmentById)
        .filter(Boolean)
        .map(garment => garment.id);
    }
    $("#builderCategories").innerHTML = categoryFilterMarkup(builderCategory, true);
    const items = serverWardrobe.garments.filter(item => builderCategory === "all" || item.category === builderCategory);
    $("#builderItems").innerHTML = items.length ? items.map(item => `
      <button type="button" class="builder-item${builderSelection.includes(item.id) ? " is-selected" : ""}" data-action="toggle-builder-item" data-id="${escapeHTML(item.id)}" aria-pressed="${builderSelection.includes(item.id)}">${imageTag(item.image, item.name)}<span>${escapeHTML(item.name)}</span></button>`
    ).join("") : `<div class="empty-inline">در این دسته لباسی نیست.</div>`;
    $("#canvasItems").innerHTML = builderSelection.length ? builderSelection.map(garmentById).filter(Boolean).map(item =>
      `<div class="canvas-item">${imageTag(item.image, item.name)}<button type="button" data-action="remove-builder-item" data-id="${escapeHTML(item.id)}" aria-label="حذف ${escapeHTML(item.name)} از ترکیب">×</button></div>`
    ).join("") : `<p class="canvas-empty">لباس‌هایی را از کمد انتخاب کن تا ترکیبت اینجا دیده شود.</p>`;
    $("#selectedCount").textContent = `${faNumber(builderSelection.length)} قطعه`;
    updateBuilderSaveButton();
  }

  function updateBuilderSaveButton() {
    const button = $("#saveOutfit");
    const nameInput = $("#outfitName");
    const name = nameInput.value.trim();
    const builderView = $('[data-page="builder"]');
    const selectedGarments = builderSelection.map(garmentById).filter(Boolean);
    const hasUniqueActiveSelection = selectedGarments.length === builderSelection.length &&
      new Set(selectedGarments.map(garment => garment.id)).size === selectedGarments.length;
    button.disabled = !isIdentityReady() || serverWardrobe.status !== "ready" ||
      outfitSubmissionInProgress || name.length > 50 ||
      selectedGarments.length === 0 || !hasUniqueActiveSelection;
    if (name.length > 0) nameInput.removeAttribute("aria-invalid");
    button.textContent = outfitSubmissionInProgress
      ? "در حال ذخیره…"
      : builderOutfitId !== null ? "ذخیره‌ی تغییرات" : "ذخیره‌ی استایل";
    button.setAttribute("aria-busy", String(outfitSubmissionInProgress));
    $("#outfitName").disabled = outfitSubmissionInProgress;
    $("#outfitOccasion").disabled = outfitSubmissionInProgress;
    $("#outfitSeason").disabled = outfitSubmissionInProgress;
    $("#cancelBuilder").disabled = outfitSubmissionInProgress;
    if (builderView) {
      $$('[data-action="toggle-builder-item"], [data-action="remove-builder-item"]', builderView)
        .forEach(itemButton => { itemButton.disabled = outfitSubmissionInProgress; });
    }
  }

  function outfitSaveErrorMessage(payload) {
    if (isRecord(payload)) {
      const detail = payload.detail || payload.non_field_errors || payload.name || payload.garments;
      if (typeof detail === "string") return detail;
      if (Array.isArray(detail)) {
        const messages = detail.filter(message => typeof message === "string");
        if (messages.length) return messages.join(" ");
      }
    }
    return "ذخیره‌ی استایل ناموفق بود. اطلاعات را بررسی و دوباره تلاش کن.";
  }

  async function submitOutfit() {
    if (outfitSubmissionInProgress || pendingOutfitDeletes.size) return;
    const editingOutfitId = builderOutfitId;
    const editing = editingOutfitId !== null;
    if (editing && !serverOutfitById(editingOutfitId)) {
      notify("این استایل دیگر در کمد سرور پیدا نمی‌شود؛ فهرست را تازه‌سازی کن.");
      return;
    }
    const name = $("#outfitName").value.trim();
    const selectedGarments = builderSelection.map(garmentById).filter(Boolean);
    if (!isIdentityReady() || serverWardrobe.status !== "ready" ||
        name.length > 50 || selectedGarments.length === 0 ||
        selectedGarments.length !== builderSelection.length ||
        new Set(selectedGarments.map(garment => garment.id)).size !== selectedGarments.length) {
      updateBuilderSaveButton();
      return;
    }
    if (name.length === 0) {
      const nameInput = $("#outfitName");
      nameInput.setAttribute("aria-invalid", "true");
      notify("لطفاً نام استایل را وارد کنید");
      nameInput.focus();
      return;
    }

    const csrfToken = getCsrfToken();
    if (!csrfToken) {
      notify("نشانه‌ی امنیتی درخواست پیدا نشد؛ صفحه را تازه‌سازی و دوباره تلاش کن.");
      return;
    }

    const requestUserId = identity.userId;
    const requestSessionVersion = calendarSessionVersion;
    const garmentIds = selectedGarments.map(garment => garment.id);
    const payload = {
      name,
      occasion: $("#outfitOccasion").value,
      season: $("#outfitSeason").value,
      garments: garmentIds.map((garment, index) => ({
        garment,
        role: "",
        order: index + 1
      }))
    };

    outfitSubmissionInProgress = true;
    updateBuilderSaveButton();
    try {
      const endpoint = editing
        ? `/api/closet/outfits/${editingOutfitId}/`
        : "/api/closet/outfits/";
      const response = await fetch(endpoint, {
        method: editing ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRFToken": csrfToken
        },
        body: JSON.stringify(payload)
      });
      if (requestSessionVersion !== calendarSessionVersion ||
          !isIdentityReady() || identity.userId !== requestUserId) return;
      if (response.status === 401 || response.status === 403 || response.redirected) {
        throw new Error("auth");
      }
      if (!response.ok) {
        let errorPayload;
        try {
          errorPayload = await response.json();
        } catch (error) {
          errorPayload = null;
        }
        if (requestSessionVersion !== calendarSessionVersion ||
            !isIdentityReady() || identity.userId !== requestUserId) return;
        notify(outfitSaveErrorMessage(errorPayload));
        return;
      }

      let outfit;
      try {
        outfit = await response.json();
      } catch (error) {
        throw new Error("invalid-response");
      }
      if (requestSessionVersion !== calendarSessionVersion ||
          !isIdentityReady() || identity.userId !== requestUserId) return;
      const activeLinks = isRecord(outfit) && Array.isArray(outfit.garments)
        ? outfit.garments.filter(link =>
          isRecord(link) && isRecord(link.garment_details) &&
          !link.garment_details.is_archived
        )
        : [];
      if (!isServerOutfitPayload([outfit]) ||
          (editing && outfit.id !== editingOutfitId) ||
          outfit.owner !== requestUserId || activeLinks.length !== garmentIds.length ||
          activeLinks.some((link, index) =>
            link.garment !== garmentIds[index] || link.role !== "" ||
            link.order !== index + 1 || link.garment_details.is_archived
          ) || (serverOutfits.ownerId !== null && serverOutfits.ownerId !== requestUserId)) {
        throw new Error("invalid-response");
      }

      serverOutfitsDataVersion += 1;
      const existingOutfitIndex = serverOutfits.outfits.findIndex(
        item => item.id === outfit.id
      );
      if (existingOutfitIndex === -1) serverOutfits.outfits.push(outfit);
      else serverOutfits.outfits[existingOutfitIndex] = outfit;
      serverOutfits.ownerId = requestUserId;
      serverOutfits.status = "ready";
      serverOutfits.error = "";
      renderOutfits();
      renderCalendar();
      renderDashboard();

      builderSelection = [];
      builderOutfitId = null;
      $("#outfitName").value = "";
      $("#outfitOccasion").value = "";
      $("#outfitSeason").value = "";
      setActiveView("outfits", true);
      notify("استایل با موفقیت ذخیره شد.");
    } catch (error) {
      if (requestSessionVersion !== calendarSessionVersion ||
          !isIdentityReady() || identity.userId !== requestUserId) return;
      console.error("Closeté outfit save failed:", error);
      if (error.message === "auth") {
        notify("نشست کاربری معتبر نیست؛ دوباره وارد حساب کاربری شو.");
      } else if (error.message === "invalid-response") {
        notify("پاسخ سرور معتبر نبود؛ انتخاب‌ها حفظ شدند.");
      } else {
        notify("ارتباط با سرور برقرار نشد؛ استایل ذخیره نشد و انتخاب‌ها حفظ شدند.");
      }
    } finally {
      outfitSubmissionInProgress = false;
      if (isIdentityReady()) renderBuilder();
    }
  }

  function colorMatchesPalette(item, palette) {
    if (palette === "neutral") return ["کرم", "مشکی", "سفید", "خاکستری"].includes(item.color);
    if (palette === "earth") return ["کرم", "قهوه‌ای", "زیتونی"].includes(item.color);
    if (palette === "dark") return ["مشکی", "سرمه‌ای", "زرشکی", "خاکستری"].includes(item.color);
    return true;
  }

  function generateRecommendations() {
    if (!isIdentityReady()) return;
    const occasion = $("#stylistOccasion").value || "روزمره";
    const season = $("#stylistSeason").value;
    const palette = $("#stylistPalette").value ||
      (preferencesLoaded ? userData.settings.palette : "") || "any";
    const suitable = state.garments.filter(item => !season || item.season === season || item.season === "چهارفصل");
    const arrange = category => suitable.filter(item => item.category === category).sort((a, b) =>
      Number(colorMatchesPalette(b, palette)) - Number(colorMatchesPalette(a, palette)) || Number(b.favorite) - Number(a.favorite)
    );
    const tops = arrange("tops");
    const bottoms = [...arrange("trousers"), ...arrange("skirts")];
    const shoes = arrange("shoes");
    const outerwear = arrange("outerwear");
    const combinations = [];
    tops.forEach(top => bottoms.forEach(bottom => {
      const layer = outerwear.length && combinations.length % 2 === 1
        ? outerwear[Math.floor(combinations.length / 2) % outerwear.length]
        : shoes.length ? shoes[combinations.length % shoes.length] : null;
      const itemIds = [top.id, bottom.id, layer && layer.id].filter(Boolean);
      if (!combinations.some(look => look.items.join("|") === itemIds.join("|"))) {
        combinations.push({ id: "suggestion-" + combinations.length, items: itemIds });
      }
    }));
    recommendationSet = combinations.slice(0, 3).map((look, index) => ({
      ...look,
      name: ["تعادلِ روزمره", "لایه‌های آرام", "کلاسیکِ خودت"][index],
      occasion,
      season: season || "چهارفصل",
      reason: index === 0
        ? `ترکیبی راحت برای ${occasion}؛ ${palette === "any" ? "با لباس‌های خودت ساخته شده." : "با پالت رنگ دلخواهت هماهنگ است."}`
        : index === 1
          ? `ترکیبی متفاوت برای ${occasion}؛ یک قطعه‌ی مکمل از کمد خودت کنار هم آمده.`
          : `ترکیبی متعادل برای ${occasion}؛ از لباس‌هایی که همین حالا در کمدت داری.`
    }));
    renderRecommendations();
  }

  function renderRecommendations() {
    if (!isIdentityReady()) return;
    $("#recommendationGrid").innerHTML = recommendationSet.length ? recommendationSet.map((look, index) => {
      const items = look.items.map(garmentById).filter(Boolean);
      return `<article class="recommendation-card"><div class="recommendation-images">${items.map(item => imageTag(item.image, item.name)).join("")}</div><div class="recommendation-body"><span class="recommendation-label">LOOK 0${index + 1} · ${escapeHTML(look.occasion)}</span><h3>${escapeHTML(look.name)}</h3><p>${escapeHTML(look.reason)}</p><button type="button" class="button button-quiet" disabled>ذخیره در مرحله‌ی بعد</button></div></article>`;
    }).join("") : `<div class="empty-state"><span>✳</span><h3>${state.garments.length ? "برای این فصل ترکیب کامل نداریم." : "برای پیشنهاد، اول کمدت را بساز."}</h3><p>${state.garments.length ? "برای ساخت یک استایل، دست‌کم یک بالاپوش و یک شلوار یا دامن متناسب با فصل انتخاب‌شده لازم است." : "پیشنهادها از لباس‌های واقعی کمدت ساخته می‌شوند."}</p><button type="button" class="button button-primary" data-view="wardrobe">رفتن به کمد</button></div>`;
  }

  function renderCalendar() {
    if (!isIdentityReady()) return;
    const grid = $("#calendarGrid");
    const dataReady = calendarDataReady();
    const { year, month } = persianDateParts(calendarCursor);
    const monthLabel = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric", month: "long" }).format(calendarCursor);
    $("#calendarMonth").textContent = monthLabel;
    const weekdays = ["ش", "ی", "د", "س", "چ", "پ", "ج"];
    const firstWeekday = (calendarCursor.getDay() + 1) % 7;
    let daysInMonth = 0;
    for (let day = 1; day <= 31; day++) {
      const date = new Date(calendarCursor);
      date.setDate(calendarCursor.getDate() + day - 1);
      const parts = persianDateParts(date);
      if (parts.year !== year || parts.month !== month) break;
      daysInMonth++;
    }
    const todayKey = localDateKey(new Date());
    const plannedDates = new Set(dataReady
      ? serverCalendar.plans.map(plan => gregorianISOToPersianKey(plan.date))
      : []);
    let markup = weekdays.map(day => `<span class="weekday">${day}</span>`).join("");
    for (let i = 0; i < firstWeekday; i++) markup += `<span class="calendar-day is-empty" aria-hidden="true"></span>`;
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(calendarCursor);
      date.setDate(calendarCursor.getDate() + day - 1);
      const key = persianDateKey(year, month, day);
      const plannedForDay = plannedDates.has(key);
      const classes = ["calendar-day", key === selectedDate ? "is-selected" : "", key === todayKey ? "is-today" : "", plannedForDay ? "is-planned" : ""].filter(Boolean).join(" ");
      markup += `<button type="button" class="${classes}" data-action="select-date" data-date="${key}" aria-pressed="${key === selectedDate}" aria-label="${escapeHTML(new Intl.DateTimeFormat("fa-IR-u-ca-persian", { day: "numeric", month: "long" }).format(date))}">${faNumber(day)}</button>`;
    }
    const filled = (firstWeekday + daysInMonth) % 7;
    for (let i = 0; i < (filled ? 7 - filled : 0); i++) markup += `<span class="calendar-day is-empty" aria-hidden="true"></span>`;
    grid.innerHTML = markup;
    const selected = dateFromKey(selectedDate);
    $("#selectedDateLabel").textContent = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { weekday: "long", day: "numeric", month: "long" }).format(selected);
    const plannedPlan = dataReady ? calendarPlanForDate(selectedDate) : null;
    const planned = plannedPlan ? serverOutfitById(plannedPlan.outfit) : null;
    const plan = $("#dayPlan");
    if (!dataReady) {
      plan.innerHTML = `<div class="empty-inline">${escapeHTML(serverCalendar.error || serverOutfits.error || "در حال دریافت اطلاعات تقویم…")}</div>`;
    } else if (plannedPlan) {
      const firstGarment = planned && planned.garments.length
        ? planned.garments.slice().sort((a, b) => a.order - b.order)[0].garment_details
        : null;
      const image = firstGarment && firstGarment.image
        ? new URL(firstGarment.image, window.location.href).href
        : "";
      plan.innerHTML = `<div class="day-plan-card">${image ? imageTag(image, planned.name) : ""}<span><strong>${escapeHTML(planned ? planned.name : "استایل در دسترس نیست")}</strong><button type="button" data-action="remove-plan" data-plan-id="${plannedPlan.id}" data-date="${selectedDate}">حذف برنامه</button></span></div>`;
    } else {
      plan.innerHTML = `<div class="empty-inline">برای این روز هنوز استایلی انتخاب نشده.</div>`;
    }

    const status = $("#calendarStatus");
    const retryButton = `<button type="button" class="button button-quiet" data-action="retry-calendar">تلاش دوباره</button>`;
    if (serverCalendar.status === "error" || serverOutfits.status === "error") {
      status.hidden = false;
      status.dataset.state = "error";
      status.innerHTML = `${escapeHTML(serverCalendar.error || serverOutfits.error)} ${retryButton}`;
    } else if (serverCalendar.status !== "ready" || serverOutfits.status !== "ready") {
      status.hidden = false;
      status.dataset.state = "loading";
      status.textContent = "در حال دریافت تقویم و استایل‌های سرور…";
    } else if (!currentCalendarOutfits().length) {
      status.hidden = false;
      status.dataset.state = "empty";
      status.innerHTML = `هنوز استایلی در سرور نداری؛ ابتدا یک استایل بساز. <button type="button" class="button button-quiet" data-view="builder">رفتن به ساخت استایل</button>`;
    } else if (!serverCalendar.plans.length) {
      status.hidden = false;
      status.dataset.state = "empty";
      status.textContent = "هنوز برنامه‌ای در تقویم ثبت نشده است.";
    } else {
      status.hidden = true;
      status.dataset.state = "loaded";
      status.textContent = "";
    }

    const select = $("#planOutfit");
    const previous = select.value;
    const calendarOutfits = currentCalendarOutfits();
    select.innerHTML = `<option value="">انتخاب استایل ذخیره‌شده</option>` + calendarOutfits.map(outfit => `<option value="${outfit.id}">${escapeHTML(outfit.name)}</option>`).join("");
    const plannedOutfitId = plannedPlan ? String(plannedPlan.outfit) : "";
    if (plannedOutfitId && calendarOutfits.some(outfit => outfit.id === Number(plannedOutfitId))) {
      select.value = plannedOutfitId;
    } else if (calendarOutfits.some(outfit => outfit.id === Number(previous))) {
      select.value = previous;
    }
    select.disabled = !dataReady || !calendarOutfits.length || pendingCalendarDates.has(selectedDate);
    $("#planForm button[type='submit']").disabled =
      !dataReady || !calendarOutfits.length || pendingCalendarDates.has(selectedDate);
  }

  function calendarApiErrorMessage(payload) {
    if (!isRecord(payload)) return "ذخیره‌ی برنامه انجام نشد؛ وضعیت تقویم را تازه‌سازی کن.";
    const details = Object.entries(payload).flatMap(([field, errors]) => {
      if (field !== "date" && field !== "outfit" && field !== "detail") return [];
      const messages = Array.isArray(errors) ? errors : [errors];
      return messages.filter(message => typeof message === "string");
    });
    return details.length
      ? details.join(" ")
      : "ذخیره‌ی برنامه انجام نشد؛ وضعیت تقویم را تازه‌سازی کن.";
  }

  async function reconcileCalendarMutation(dateKey, operation, outfitId) {
    await fetchServerCalendar(true);
    if (!calendarDataReady()) return false;
    const currentPlan = calendarPlanForDate(dateKey);
    if (operation === "delete") return !currentPlan;
    return Boolean(currentPlan && currentPlan.outfit === outfitId);
  }

  async function submitCalendarPlan(event) {
    event.preventDefault();
    if (pendingCalendarDates.size) return;
    if (!calendarDataReady()) {
      notify("تقویم هنوز از سرور دریافت نشده؛ پس از بارگذاری دوباره تلاش کن.");
      return;
    }

    const outfitId = Number($("#planOutfit").value);
    if (!currentCalendarOutfits().some(outfit => outfit.id === outfitId)) {
      notify("یک استایل ذخیره‌شده در سرور انتخاب کن.");
      return;
    }
    const dateKey = selectedDate;
    const gregorianDate = persianDateToGregorianISO(dateKey);
    if (!gregorianDate) {
      notify("تاریخ انتخاب‌شده معتبر نیست.");
      return;
    }
    if (pendingCalendarDates.has(dateKey)) return;

    const existingPlan = calendarPlanForDate(dateKey);
    const endpoint = existingPlan
      ? `/api/closet/calendar/${existingPlan.id}/`
      : "/api/closet/calendar/";
    const method = existingPlan ? "PATCH" : "POST";
    const csrfToken = getCsrfToken();
    if (!csrfToken) {
      notify("نشانه‌ی امنیتی درخواست پیدا نشد؛ صفحه را تازه‌سازی و دوباره تلاش کن.");
      return;
    }

    const requestSessionVersion = calendarSessionVersion;
    pendingCalendarDates.add(dateKey);
    renderCalendar();
    try {
      const response = await fetch(endpoint, {
        method,
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRFToken": csrfToken
        },
        body: JSON.stringify(existingPlan
          ? { outfit: outfitId }
          : { date: gregorianDate, outfit: outfitId })
      });
      if (requestSessionVersion !== calendarSessionVersion) return;
      if (response.status === 401 || response.status === 403 || response.redirected) {
        throw new Error("auth");
      }
      if (!response.ok) {
        let payload;
        try {
          payload = await response.json();
        } catch (error) {
          payload = null;
        }
        await fetchServerCalendar(true);
        notify(calendarApiErrorMessage(payload));
        return;
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error("invalid-response");
      }
      if (
        !isServerCalendarPayload([payload]) ||
        payload.date !== gregorianDate ||
        payload.outfit !== outfitId ||
        (serverOutfits.ownerId !== null && payload.owner !== serverOutfits.ownerId)
      ) {
        throw new Error("invalid-response");
      }
      serverCalendar.plans = [
        ...serverCalendar.plans.filter(plan => plan.date !== gregorianDate),
        payload
      ].sort((a, b) => a.date.localeCompare(b.date));
      serverCalendar.ownerId = payload.owner;
      serverCalendar.status = "ready";
      serverCalendar.error = "";
      if (!validateCalendarOwner()) {
        notify(serverCalendar.error);
        return;
      }
      renderCalendar();
      renderDashboard();
      notify(existingPlan ? "برنامه‌ی این روز به‌روزرسانی شد." : "استایل برای این روز برنامه‌ریزی شد.");
    } catch (error) {
      if (requestSessionVersion !== calendarSessionVersion) return;
      console.error("Closeté calendar save failed:", error);
      if (error.message === "auth") {
        resetCalendarSessionData();
        serverCalendar.status = "error";
        serverCalendar.error = "نشست کاربری معتبر نیست؛ دوباره وارد حساب کاربری شو.";
      } else {
        const saved = await reconcileCalendarMutation(
          dateKey,
          "save",
          outfitId
        );
        if (saved) {
          notify("برنامه در سرور ثبت شده و از سرور دوباره دریافت شد.");
        } else if (error.message === "invalid-response") {
          notify("پاسخ سرور قابل‌خواندن نبود؛ تقویم را تازه‌سازی کن.");
        } else {
          notify("نتیجه‌ی درخواست مشخص نیست؛ تقویم از سرور بررسی شد. پیش از تلاش دوباره وضعیت را ببین.");
        }
      }
    } finally {
      if (requestSessionVersion === calendarSessionVersion) {
        pendingCalendarDates.delete(dateKey);
        renderCalendar();
        renderDashboard();
      }
    }
  }

  async function deleteCalendarPlan(planId, dateKey) {
    if (pendingCalendarDates.size) return;
    const plan = serverCalendar.plans.find(item => item.id === Number(planId));
    if (!plan || plan.date !== persianDateToGregorianISO(dateKey)) {
      notify("برنامه‌ی این روز دیگر در فهرست سرور نیست؛ تقویم را تازه‌سازی کن.");
      return;
    }
    const csrfToken = getCsrfToken();
    if (!csrfToken) {
      notify("نشانه‌ی امنیتی درخواست پیدا نشد؛ صفحه را تازه‌سازی و دوباره تلاش کن.");
      return;
    }

    const requestSessionVersion = calendarSessionVersion;
    pendingCalendarDates.add(dateKey);
    renderCalendar();
    try {
      const response = await fetch(`/api/closet/calendar/${plan.id}/`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "X-CSRFToken": csrfToken
        }
      });
      if (requestSessionVersion !== calendarSessionVersion) return;
      if (response.status === 401 || response.status === 403 || response.redirected) {
        throw new Error("auth");
      }
      if (!response.ok) {
        await fetchServerCalendar(true);
        notify(response.status === 404
          ? "برنامه در سرور پیدا نشد؛ تقویم به‌روزرسانی شد."
          : "حذف برنامه انجام نشد؛ اطلاعات سرور تغییر نکرد.");
        return;
      }
      serverCalendar.plans = serverCalendar.plans.filter(item => item.id !== plan.id);
      renderCalendar();
      renderDashboard();
      notify("برنامه‌ی این روز حذف شد.");
    } catch (error) {
      if (requestSessionVersion !== calendarSessionVersion) return;
      console.error("Closeté calendar delete failed:", error);
      if (error.message === "auth") {
        resetCalendarSessionData();
        serverCalendar.status = "error";
        serverCalendar.error = "نشست کاربری معتبر نیست؛ دوباره وارد حساب کاربری شو.";
      } else if (await reconcileCalendarMutation(dateKey, "delete")) {
        notify("برنامه از سرور حذف شده و تقویم تازه‌سازی شد.");
      } else {
        notify("نتیجه‌ی حذف مشخص نیست؛ تقویم از سرور بررسی شد. دوباره وضعیت را ببین.");
      }
    } finally {
      if (requestSessionVersion === calendarSessionVersion) {
        pendingCalendarDates.delete(dateKey);
        renderCalendar();
        renderDashboard();
      }
    }
  }

  function renderSettings() {
    if (!isIdentityReady() || !preferencesLoaded) return;
    $("#displayName").value = userData.settings.name || "";
    $("#preferredStyle").value = userData.settings.style || "مینیمال";
    $$('input[name="palette"]').forEach(input => input.checked = input.value === getPalette());
    $("#settingsAvatar").textContent = (userData.settings.name || "م").trim().charAt(0) || "م";
  }

  function openGarmentModal(garmentId) {
    const item = garmentId ? serverGarmentById(garmentId) : null;
    if (garmentId && !item) {
      notify("این لباس دیگر در کمد سرور پیدا نمی‌شود.");
      return;
    }
    savedGarmentImageUrl = item && item.image ? item.image : "";
    clearGarmentImageSelection();
    $("#garmentForm").reset();
    $("#garmentImage").value = "";
    $("#garmentId").value = item ? item.id : "";
    $("#garmentName").value = item ? item.name : "";
    $("#garmentSubcategory").value = item ? item.subcategory || "" : "";
    $("#garmentSecondaryColors").value = item && Array.isArray(item.secondary_colors)
      ? item.secondary_colors.join("، ")
      : "";
    $("#garmentPattern").value = item ? item.pattern || "" : "";
    $("#garmentMaterial").value = item ? item.material || "" : "";
    $("#garmentStyle").value = item ? item.style || "" : "";
    $("#garmentDescription").value = item ? item.description || "" : "";
    $("#garmentCategory").innerHTML = categories.map(key => `<option value="${key}">${categoryNames[key]}</option>`).join("");
    $("#garmentColor").innerHTML = `<option value="">انتخاب رنگ</option>` +
      colors.map(color => `<option>${color}</option>`).join("");
    $("#garmentCategory").value = item ? item.category : "tops";
    $("#garmentColor").value = item ? item.color : "";
    $("#garmentSeason").value = item ? item.season || "چهارفصل" : "چهارفصل";
    $("#garmentOccasion").value = item ? item.occasion || "" : "";
    $("#formError").textContent = "";
    restoreGarmentImagePreview();
    $("#modalTitle").textContent = item ? "ویرایش لباس" : "افزودن لباس";
    $("#saveGarmentButton").textContent = item ? "ذخیره‌ی تغییرات" : "ذخیره‌ی لباس";
    $("#modalBackdrop").hidden = false;
    $("#garmentName").focus();
  }

  function revokePendingImagePreview() {
    if (pendingImagePreviewUrl) {
      URL.revokeObjectURL(pendingImagePreviewUrl);
      pendingImagePreviewUrl = "";
    }
  }

  function restoreGarmentImagePreview() {
    $("#uploadPreview").innerHTML = savedGarmentImageUrl
      ? imageTag(savedGarmentImageUrl, "پیش‌نمایش لباس")
      : "＋";
  }

  function clearGarmentImageSelection() {
    imageSelectionVersion += 1;
    revokePendingImagePreview();
    if (resolvePendingImageValidation) {
      resolvePendingImageValidation();
      resolvePendingImageValidation = null;
    }
    pendingImageValidation = Promise.resolve();
    pendingImageValidationError = "";
    $("#garmentImage").value = "";
    restoreGarmentImagePreview();
  }

  function closeGarmentModal() {
    if (garmentSubmissionInProgress) return;
    $("#modalBackdrop").hidden = true;
    clearGarmentImageSelection();
    savedGarmentImageUrl = "";
    $("#garmentForm").reset();
    $("#uploadPreview").textContent = "＋";
    $("#formError").textContent = "";
  }

  function garmentFormData() {
    const formData = new FormData($("#garmentForm"));
    const secondaryColors = $("#garmentSecondaryColors").value
      .split(/[,،]/)
      .map(color => color.trim())
      .filter(Boolean);
    formData.set("secondary_colors", JSON.stringify(secondaryColors));
    formData.delete("garmentId");
    formData.delete("csrfmiddlewaretoken");
    if ($("#garmentId").value && !$("#garmentImage").files.length) {
      formData.delete("image");
    }
    return formData;
  }

  function garmentApiErrorMessage(payload) {
    if (!isRecord(payload)) return "ذخیره‌ی لباس ناموفق بود. اطلاعات را بررسی و دوباره تلاش کن.";

    const fieldNames = {
      name: "نام لباس",
      category: "دسته‌بندی",
      subcategory: "زیرگروه",
      color: "رنگ اصلی",
      secondary_colors: "رنگ‌های فرعی",
      season: "فصل",
      occasion: "مناسبت",
      pattern: "طرح",
      material: "جنس",
      style: "سبک",
      description: "توضیحات",
      image: "تصویر"
    };
    const messages = Object.entries(payload).flatMap(([field, errors]) => {
      if (!fieldNames[field]) return [];
      const details = Array.isArray(errors) ? errors : [errors];
      return details
        .filter(message => typeof message === "string")
        .map(message => `${fieldNames[field]}: ${message}`);
    });
    return messages.length
      ? messages.join(" ")
      : "اطلاعات لباس معتبر نیست؛ فیلدها را بررسی و دوباره تلاش کن.";
  }

  async function submitGarment(event) {
    event.preventDefault();
    if (garmentSubmissionInProgress) return;

    const garmentId = $("#garmentId").value;
    const editing = Boolean(garmentId);
    if (editing && !serverGarmentById(garmentId)) {
      $("#formError").textContent = "این لباس دیگر در کمد سرور پیدا نمی‌شود؛ فهرست را تازه‌سازی کن.";
      return;
    }

    const selectedImage = $("#garmentImage").files[0];
    const selectedImageVersion = imageSelectionVersion;
    const selectedImageValidation = pendingImageValidation;
    if (pendingImageValidationError) {
      $("#formError").textContent = pendingImageValidationError;
      return;
    }

    const csrfToken = getCsrfToken();
    if (!csrfToken) {
      $("#formError").textContent = "نشانه‌ی امنیتی درخواست پیدا نشد؛ صفحه را تازه‌سازی و دوباره تلاش کن.";
      return;
    }

    const submitButton = $("#saveGarmentButton");
    const closeButton = $("#closeModal");
    const cancelButton = $("#cancelModal");
    garmentSubmissionInProgress = true;
    submitButton.disabled = true;
    submitButton.setAttribute("aria-busy", "true");
    submitButton.textContent = "در حال ذخیره…";
    closeButton.disabled = true;
    cancelButton.disabled = true;
    $("#formError").textContent = "";

    try {
      if (selectedImage) {
        await selectedImageValidation;
        if (imageSelectionVersion !== selectedImageVersion) {
          $("#formError").textContent = "تصویر انتخاب‌شده تغییر کرد؛ دوباره تلاش کن.";
          return;
        }
        if (pendingImageValidationError) {
          $("#formError").textContent = pendingImageValidationError;
          return;
        }
        if ($("#garmentImage").files[0] !== selectedImage) {
          $("#formError").textContent = "تصویر انتخاب‌شده تغییر کرد؛ دوباره تلاش کن.";
          return;
        }
      }

      const formData = garmentFormData();
      $("#garmentImage").disabled = true;

      const endpoint = editing
        ? `/api/closet/garments/${garmentId}/`
        : "/api/closet/garments/";
      const response = await fetch(endpoint, {
        method: editing ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "X-CSRFToken": csrfToken
        },
        body: formData
      });

      if (response.status === 401 || response.redirected) {
        throw new Error("auth");
      }
      if (response.status === 403) throw new Error("forbidden");
      if (editing && response.status === 404) throw new Error("not-found");
      if (response.status === 413) {
        clearGarmentImageSelection();
        throw new Error("too-large");
      }
      if (response.status === 400) {
        let payload;
        try {
          payload = await response.json();
        } catch (error) {
          throw new Error("invalid-response");
        }
        const imageRejected = isRecord(payload) &&
          Object.prototype.hasOwnProperty.call(payload, "image");
        if (imageRejected) clearGarmentImageSelection();
        $("#formError").textContent = garmentApiErrorMessage(payload);
        return;
      }
      if (!response.ok) throw new Error("server");

      let garment;
      try {
        garment = await response.json();
      } catch (error) {
        throw new Error("invalid-response");
      }
      if (!isServerGarment(garment) ||
          (editing && garment.id !== Number(garmentId)) ||
          (!editing && garment.is_archived)) {
        throw new Error("invalid-response");
      }

      if (serverWardrobeRequest) await serverWardrobeRequest;
      if (editing) {
        const activeIndex = serverWardrobe.garments.findIndex(item => item.id === garment.id);
        const archivedIndex = serverWardrobe.archivedGarments.findIndex(item => item.id === garment.id);
        serverWardrobe.garments = serverWardrobe.garments.filter(item => item.id !== garment.id);
        serverWardrobe.archivedGarments = serverWardrobe.archivedGarments.filter(item => item.id !== garment.id);
        const destination = garment.is_archived
          ? serverWardrobe.archivedGarments
          : serverWardrobe.garments;
        const destinationIndex = garment.is_archived ? archivedIndex : activeIndex;
        if (destinationIndex >= 0) {
          destination.splice(Math.min(destinationIndex, destination.length), 0, garment);
        } else {
          destination.unshift(garment);
        }
        serverOutfits.outfits.forEach(outfit => {
          outfit.garments.forEach(link => {
            if (link.garment === garment.id) link.garment_details = garment;
          });
        });
      } else {
        serverWardrobe.garments = serverWardrobe.garments.filter(
          item => item.id !== garment.id
        );
        serverWardrobe.garments.unshift(garment);
      }
      serverWardrobe.status = "ready";
      serverWardrobe.error = "";
      renderHeader();
      renderDashboard();
      renderWardrobe();
      renderBuilder();
      renderOutfits();

      garmentSubmissionInProgress = false;
      closeGarmentModal();
      notify(editing ? "تغییرات لباس ذخیره شد." : "لباس با موفقیت به کمد سرور اضافه شد.");
    } catch (error) {
      console.error("Closeté garment save failed:", error);
      if (error.message === "auth") {
        $("#formError").textContent = "نشست کاربری معتبر نیست؛ دوباره وارد حساب کاربری شو.";
      } else if (error.message === "forbidden") {
        $("#formError").textContent = "درخواست رد شد؛ صفحه را تازه‌سازی و دوباره تلاش کن.";
      } else if (error.message === "not-found") {
        $("#formError").textContent = "این لباس دیگر در کمدت پیدا نمی‌شود.";
      } else if (error.message === "too-large") {
        $("#formError").textContent = "حجم تصویر بیش از حد مجاز است.";
      } else if (error.message === "invalid-response") {
        $("#formError").textContent = "پاسخ سرور قابل‌خواندن نیست؛ دوباره تلاش کن.";
      } else if (error instanceof TypeError) {
        $("#formError").textContent = "ارتباط با سرور برقرار نشد؛ اتصال شبکه را بررسی و دوباره تلاش کن.";
      } else {
        $("#formError").textContent = "ذخیره‌ی لباس ناموفق بود؛ کمی بعد دوباره تلاش کن.";
      }
    } finally {
      garmentSubmissionInProgress = false;
      submitButton.disabled = false;
      submitButton.removeAttribute("aria-busy");
      submitButton.textContent = $("#garmentId").value ? "ذخیره‌ی تغییرات" : "ذخیره‌ی لباس";
      closeButton.disabled = false;
      cancelButton.disabled = false;
      $("#garmentImage").disabled = false;
      $("#garmentImage").disabled = false;
    }
  }

  function clearFilters() {
    activeCategory = "all";
    $("#garmentSearch").value = "";
    $("#colorFilter").value = "";
    $("#seasonFilter").value = "";
    $("#occasionFilter").value = "";
    renderWardrobe();
  }

  function ensureDeleteGarmentConfirmation() {
    if ($("#deleteGarmentBackdrop")) return;
    body.insertAdjacentHTML("beforeend", `
      <div class="modal-backdrop" id="deleteGarmentBackdrop" hidden>
        <section class="form-modal delete-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="deleteGarmentTitle" aria-describedby="deleteGarmentDescription" tabindex="-1">
          <div class="modal-head">
            <div><p class="eyebrow">PERMANENT ACTION</p><h2 id="deleteGarmentTitle">حذف دائمی لباس</h2></div>
            <button type="button" class="modal-close" id="closeDeleteGarment" aria-label="انصراف از حذف">×</button>
          </div>
          <p class="delete-confirm-name" id="deleteGarmentName"></p>
          <p class="delete-confirm-copy" id="deleteGarmentDescription">این حذف دائمی است. اگر لباس در استایل ذخیره‌شده استفاده شده باشد، حذف انجام نمی‌شود. برای خارج‌کردن لباس از کمد فعال می‌توانید آن را آرشیو کنید.</p>
          <p class="form-error" id="deleteGarmentError" role="alert" aria-live="assertive"></p>
          <div class="modal-actions">
            <button type="button" class="button button-quiet" id="cancelDeleteGarment">انصراف</button>
            <button type="button" class="button button-danger" id="confirmDeleteGarment">حذف دائمی</button>
          </div>
        </section>
      </div>`);
  }

  function removeGarment(garmentId) {
    const id = Number(garmentId);
    const garment = Number.isInteger(id) ? serverGarmentById(id) : null;
    if (!garment) {
      notify("این لباس دیگر در کمد سرور پیدا نمی‌شود؛ فهرست در حال تازه‌سازی است.");
      fetchServerGarments();
      return;
    }
    if (pendingGarmentUpdates.has(id)) return;

    deleteGarmentDialogId = id;
    deleteGarmentReturnFocus = document.activeElement;
    $("#deleteGarmentName").textContent = garment.name;
    $("#deleteGarmentError").textContent = "";
    $("#deleteGarmentBackdrop").hidden = false;
    $("#cancelDeleteGarment").focus();
  }

  function closeDeleteGarmentConfirmation() {
    if (deleteGarmentDialogId !== null && pendingGarmentDeletes.has(deleteGarmentDialogId)) return;
    $("#deleteGarmentBackdrop").hidden = true;
    deleteGarmentDialogId = null;
    const returnFocus = deleteGarmentReturnFocus;
    deleteGarmentReturnFocus = null;
    if (returnFocus && returnFocus.isConnected) {
      returnFocus.focus();
    } else {
      $('[data-page="wardrobe"] [data-action="add-garment"]')?.focus();
    }
  }

  async function confirmDeleteGarment(garmentId) {
    const id = Number(garmentId);
    if (!Number.isInteger(id) || id !== deleteGarmentDialogId || pendingGarmentUpdates.has(id)) return;
    if (!serverGarmentById(id)) {
      closeDeleteGarmentConfirmation();
      notify("این لباس دیگر در کمد سرور پیدا نمی‌شود؛ فهرست در حال تازه‌سازی است.");
      fetchServerGarments();
      return;
    }

    const csrfToken = getCsrfToken();
    if (!csrfToken) {
      $("#deleteGarmentError").textContent = "نشانه‌ی امنیتی درخواست پیدا نشد؛ صفحه را تازه‌سازی و دوباره تلاش کن.";
      return;
    }

    const confirmButton = $("#confirmDeleteGarment");
    const cancelButton = $("#cancelDeleteGarment");
    let refreshList = false;
    pendingGarmentUpdates.add(id);
    pendingGarmentDeletes.add(id);
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    confirmButton.setAttribute("aria-busy", "true");
    confirmButton.textContent = "در حال حذف…";
    renderWardrobe();

    try {
      const response = await fetch(`/api/closet/garments/${id}/`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "X-CSRFToken": csrfToken
        }
      });

      if (response.status === 401 || response.redirected) {
        notify("برای حذف لباس، نشست کاربری معتبر لازم است. دوباره وارد حساب شو.");
      } else if (response.status === 403) {
        notify("اجازه‌ی حذف این لباس را ندارید یا نشانه‌ی امنیتی درخواست معتبر نیست.");
      } else if (response.status === 404) {
        refreshList = true;
        notify("این لباس دیگر در دسترس نیست؛ فهرست کمد از سرور تازه‌سازی می‌شود.");
      } else if (response.status === 409) {
        const fallback = "این لباس در یک یا چند استایل ذخیره‌شده استفاده شده است و امکان حذف دائمی آن وجود ندارد. می‌توانید آن را آرشیو کنید.";
        let message = fallback;
        try {
          const payload = await response.json();
          if (payload && typeof payload.detail === "string" && payload.detail.trim()) {
            message = payload.detail;
          }
        } catch (error) {
          console.warn("Closeté garment delete conflict response was unreadable.");
        }
        notify(message);
      } else if (response.status === 204) {
        serverWardrobe.garments = serverWardrobe.garments.filter(item => item.id !== id);
        serverWardrobe.archivedGarments = serverWardrobe.archivedGarments
          .filter(item => item.id !== id);
        renderHeader();
        renderDashboard();
        renderWardrobe();
        renderBuilder();
        notify("لباس به‌طور دائمی حذف شد.");
      } else {
        console.error("Closeté garment delete request failed with status:", response.status);
        notify("حذف لباس انجام نشد؛ کمی بعد دوباره تلاش کن.");
      }
    } catch (error) {
      console.error("Closeté garment delete request failed:", error);
      notify("ارتباط با سرور برقرار نشد؛ وضعیت کمد تغییر نکرد.");
    } finally {
      pendingGarmentUpdates.delete(id);
      pendingGarmentDeletes.delete(id);
      confirmButton.disabled = false;
      cancelButton.disabled = false;
      confirmButton.removeAttribute("aria-busy");
      confirmButton.textContent = "حذف دائمی";
      closeDeleteGarmentConfirmation();
      renderWardrobe();
      if (refreshList) fetchServerGarments();
    }
  }

  function removeOutfit(outfitId) {
    const id = Number(outfitId);
    const outfit = serverOutfitById(id);
    if (!outfit) {
      notify("این استایل دیگر در کمد سرور پیدا نمی‌شود؛ فهرست را تازه‌سازی کن.");
      void fetchServerOutfits(true);
      return;
    }
    if (pendingOutfitDeletes.has(id) || outfitSubmissionInProgress) return;
    if (!window.confirm(`استایل «${outfit.name}» حذف شود؟`)) return;

    const csrfToken = getCsrfToken();
    if (!csrfToken) {
      notify("نشانه‌ی امنیتی درخواست پیدا نشد؛ صفحه را تازه‌سازی و دوباره تلاش کن.");
      return;
    }

    const requestSessionVersion = calendarSessionVersion;
    pendingOutfitDeletes.add(id);
    renderOutfits();
    void (async () => {
      try {
        const response = await fetch(`/api/closet/outfits/${id}/`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "X-CSRFToken": csrfToken
          }
        });
        if (requestSessionVersion !== calendarSessionVersion ||
            !isIdentityReady() || identity.userId !== outfit.owner) return;
        if (response.status === 401 || response.status === 403 || response.redirected) {
          throw new Error("auth");
        }
        if (!response.ok) {
          let payload;
          try {
            payload = await response.json();
          } catch (error) {
            payload = null;
          }
          if (requestSessionVersion !== calendarSessionVersion ||
              !isIdentityReady() || identity.userId !== outfit.owner) return;
          const detail = isRecord(payload) && typeof payload.detail === "string"
            ? payload.detail
            : "حذف استایل انجام نشد؛ ممکن است در برنامه‌ی تقویم استفاده شده باشد.";
          notify(detail);
          return;
        }

        serverOutfitsDataVersion += 1;
        serverOutfits.outfits = serverOutfits.outfits.filter(item => item.id !== id);
        serverOutfits.ownerId = outfit.owner;
        serverOutfits.status = "ready";
        serverOutfits.error = "";
        renderOutfits();
        renderCalendar();
        renderDashboard();
        notify("استایل حذف شد.");
      } catch (error) {
        if (requestSessionVersion !== calendarSessionVersion ||
            !isIdentityReady() || identity.userId !== outfit.owner) return;
        console.error("Closeté outfit delete failed:", error);
        notify(error.message === "auth"
          ? "نشست کاربری معتبر نیست؛ دوباره وارد حساب کاربری شو."
          : "ارتباط با سرور برقرار نشد؛ استایل حذف نشد.");
      } finally {
        pendingOutfitDeletes.delete(id);
        if (requestSessionVersion === calendarSessionVersion &&
            isIdentityReady() && identity.userId === outfit.owner) {
          renderOutfits();
        }
      }
    })();
  }

  function renderAll() {
    if (!isIdentityReady()) return;
    renderHeader();
    renderDashboard();
    renderWardrobe();
    renderOutfits();
    renderBuilder();
    renderCalendar();
  }

  function refreshAll() {
    if (!isIdentityReady()) return;
    renderAll();
    if (recommendationSet.length) generateRecommendations();
  }

  function refreshCalendarForCurrentSession() {
    if (document.visibilityState === "hidden") return;
    const csrfToken = getCsrfToken();
    if (csrfToken !== calendarCsrfToken) {
      resetCalendarSessionData();
      calendarCsrfToken = csrfToken;
      lastCalendarRefreshAt = 0;
    }
    const now = Date.now();
    if (now - lastCalendarRefreshAt < 2500) return;
    lastCalendarRefreshAt = now;
    refreshCalendarData(true);
  }

  function initEvents() {
    document.addEventListener("click", event => {
      const outfitSourceButton = event.target.closest("[data-outfit-source]");
      if (outfitSourceButton) {
        outfitSource = outfitSourceButton.dataset.outfitSource;
        renderOutfits();
        if (outfitSource === "server" && serverOutfits.status === "idle") fetchServerOutfits();
        return;
      }
      if (event.target.closest('[data-action="retry-server-outfits"]')) {
        serverOutfits.status = "idle";
        fetchServerOutfits();
        return;
      }
      if (event.target.closest('[data-action="retry-calendar"]')) {
        refreshCalendarData(true);
        return;
      }
      const wardrobeModeButton = event.target.closest("[data-wardrobe-mode]");
      if (wardrobeModeButton) {
        wardrobeMode = wardrobeModeButton.dataset.wardrobeMode;
        if (wardrobeMode === "server" && serverWardrobe.status === "idle") fetchServerGarments();
        renderWardrobe();
        return;
      }
      if (event.target.closest('[data-action="retry-server-wardrobe"]')) {
        serverWardrobe.status = "idle";
        fetchServerGarments();
        return;
      }
      const archiveButton = event.target.closest(
        '[data-action="archive-garment"], [data-action="restore-garment"]'
      );
      if (archiveButton) {
        updateGarmentArchive(
          Number(archiveButton.dataset.id),
          archiveButton.dataset.action === "archive-garment"
        );
        return;
      }
      const viewButton = event.target.closest("[data-view]");
      if (viewButton) {
        event.preventDefault();
        setActiveView(viewButton.dataset.view, true, Boolean(viewButton.closest("#appSidebar")));
        return;
      }
      const actionButton = event.target.closest("[data-action]");
      if (actionButton) {
        const action = actionButton.dataset.action;
        const actionId = actionButton.dataset.id;
        if (action === "add-garment") {
          openGarmentModal();
          return;
        }
        if (action === "edit-garment") {
          openGarmentModal(actionId);
          return;
        }
        if (action === "delete-garment") {
          removeGarment(actionId);
          return;
        }
        if (action === "favorite") notify("کمد قدیمی فقط‌خواندنی است.");
        if (action === "edit-outfit") startBuilder(actionId);
        if (action === "delete-outfit") removeOutfit(actionId);
        if (action === "plan-outfit") {
          selectedDate = localDateKey(new Date());
          setActiveView("calendar", true);
          $("#planOutfit").value = "";
          $("#planOutfit").focus();
        }
        if (action === "toggle-builder-item") {
          const garment = garmentById(actionId);
          if (!garment) return;
          const garmentId = garment.id;
          builderSelection = builderSelection.includes(garmentId)
            ? builderSelection.filter(itemId => itemId !== garmentId)
            : [...builderSelection, garmentId];
          renderBuilder();
        }
        if (action === "remove-builder-item") {
          builderSelection = builderSelection.filter(itemId => itemId !== Number(actionId));
          renderBuilder();
        }
        if (action === "save-recommendation") {
          notify("ذخیره‌ی استایل در مرحله‌ی بعد فعال می‌شود.");
        }
        if (action === "select-date") {
          selectedDate = actionButton.dataset.date;
          renderCalendar();
        }
        if (action === "remove-plan") {
          deleteCalendarPlan(actionButton.dataset.planId, actionButton.dataset.date);
        }
      }
      const category = event.target.closest("[data-category]");
      if (category) {
        const parent = category.parentElement;
        if (parent.id === "categoryFilters") {
          activeCategory = category.dataset.category;
          renderWardrobe();
        } else if (parent.id === "builderCategories") {
          builderCategory = category.dataset.category;
          renderBuilder();
        }
      }
      if (event.target.id === "emptyClearFilters") clearFilters();
      if (event.target.id === "closeModal" || event.target.id === "cancelModal" || event.target.id === "modalBackdrop") closeGarmentModal();
      if (event.target.id === "closeDeleteGarment" || event.target.id === "cancelDeleteGarment" || event.target.id === "deleteGarmentBackdrop") closeDeleteGarmentConfirmation();
      if (event.target.id === "sidebarBackdrop") setSidebarOpen(false);
      if (event.target.id === "sidebarClose") setSidebarOpen(false);
    });

    $("#mobileMenu").addEventListener("click", () => setSidebarOpen($("#mobileMenu").getAttribute("aria-expanded") !== "true"));
    window.addEventListener("resize", () => {
      const drawerMode = window.innerWidth <= 900;
      if (drawerMode !== previousDrawerMode) {
        previousDrawerMode = drawerMode;
        setSidebarOpen(false);
      }
    });
    $("#garmentSearch").addEventListener("input", renderWardrobe);
    ["colorFilter", "seasonFilter", "occasionFilter", "sortGarments"].forEach(id => $("#" + id).addEventListener("change", renderWardrobe));
    $("#clearFilters").addEventListener("click", clearFilters);
    $("#closeModal").addEventListener("click", closeGarmentModal);
    $("#cancelModal").addEventListener("click", closeGarmentModal);
    $("#closeDeleteGarment").addEventListener("click", closeDeleteGarmentConfirmation);
    $("#cancelDeleteGarment").addEventListener("click", closeDeleteGarmentConfirmation);
    $("#confirmDeleteGarment").addEventListener("click", () => {
      if (deleteGarmentDialogId !== null) confirmDeleteGarment(deleteGarmentDialogId);
    });
    $("#garmentImage").addEventListener("change", async event => {
      const file = event.target.files && event.target.files[0];
      const selectionVersion = ++imageSelectionVersion;
      if (resolvePendingImageValidation) {
        resolvePendingImageValidation();
        resolvePendingImageValidation = null;
      }
      revokePendingImagePreview();
      pendingImageValidation = Promise.resolve();
      pendingImageValidationError = "";
      restoreGarmentImagePreview();
      $("#formError").textContent = "";
      if (!file) return;

      const extension = file.name.split(".").pop().toLowerCase();
      if (!["jpg", "jpeg", "png", "webp"].includes(extension)) {
        pendingImageValidationError = "فقط تصویرهای JPG، PNG یا WebP قابل انتخاب هستند.";
        $("#garmentImage").value = "";
        $("#formError").textContent = pendingImageValidationError;
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        pendingImageValidationError = "حجم تصویر نباید از ۵ مگابایت بیشتر باشد.";
        $("#garmentImage").value = "";
        $("#formError").textContent = pendingImageValidationError;
        return;
      }
      try {
        pendingImagePreviewUrl = URL.createObjectURL(file);
      } catch (error) {
        pendingImageValidationError = "پیش‌نمایش تصویر ممکن نشد؛ فایل دیگری را انتخاب کن.";
        $("#garmentImage").value = "";
        $("#formError").textContent = pendingImageValidationError;
        return;
      }
      const previewUrl = pendingImagePreviewUrl;
      const previewImage = new Image();
      pendingImageValidation = new Promise(resolve => {
        resolvePendingImageValidation = resolve;
        const finishValidation = errorMessage => {
          if (selectionVersion !== imageSelectionVersion) {
            if (resolvePendingImageValidation === resolve) {
              resolvePendingImageValidation = null;
            }
            resolve();
            return;
          }
          pendingImageValidationError = errorMessage;
          if (errorMessage) {
            revokePendingImagePreview();
            $("#garmentImage").value = "";
            restoreGarmentImagePreview();
            $("#formError").textContent = errorMessage;
          }
          if (resolvePendingImageValidation === resolve) {
            resolvePendingImageValidation = null;
          }
          resolve();
        };
      previewImage.onerror = () => {
          finishValidation("این تصویر قابل نمایش نیست؛ فایل دیگری را انتخاب کن.");
      };
      previewImage.onload = () => {
          if (selectionVersion !== imageSelectionVersion) {
            if (resolvePendingImageValidation === resolve) {
              resolvePendingImageValidation = null;
            }
            resolve();
            return;
          }
          if (previewImage.naturalWidth > 6000 ||
              previewImage.naturalHeight > 6000 ||
              previewImage.naturalWidth * previewImage.naturalHeight > 25000000) {
            finishValidation("ابعاد تصویر از حد مجاز بیشتر است.");
            return;
          }
          if (pendingImagePreviewUrl !== previewUrl) {
            resolve();
            return;
          }
        $("#uploadPreview").innerHTML = imageTag(
            previewUrl,
          "پیش‌نمایش تصویر انتخاب‌شده"
        );
        $("#formError").textContent = "";
          finishValidation("");
      };
        previewImage.src = previewUrl;
      });
    });
    $("#garmentForm").addEventListener("submit", submitGarment);

    $("#outfitName").addEventListener("input", updateBuilderSaveButton);
    $("#saveOutfit").addEventListener("click", submitOutfit);
    $("#cancelBuilder").addEventListener("click", () => {
      builderSelection = [];
      builderOutfitId = null;
      $("#outfitName").value = "";
      $("#outfitOccasion").value = "";
      $("#outfitSeason").value = "";
      renderBuilder();
    });
    $("#generateLooks").addEventListener("click", generateRecommendations);
    $("#regenerateLooks").addEventListener("click", generateRecommendations);
    function changeCalendarMonth(offset) {
      const current = persianDateParts(calendarCursor);
      const month = shiftPersianMonth(current.year, current.month, offset);
      calendarCursor = persianMonthStart(month.year, month.month);
      renderCalendar();
    }
    $("#prevMonth").addEventListener("click", () => changeCalendarMonth(-1));
    $("#nextMonth").addEventListener("click", () => changeCalendarMonth(1));
    $("#planForm").addEventListener("submit", submitCalendarPlan);
    $("#settingsForm").addEventListener("submit", event => {
      event.preventDefault();
      if (!isIdentityReady() || !preferencesLoaded || preferencesSaving) {
        notify("ابتدا تنظیمات حساب را بارگیری کن.");
        return;
      }
      const name = $("#displayName").value.trim();
      if (!name) {
        $("#displayName").focus();
        notify("نام نمایشی را وارد کن.");
        return;
      }
      const settings = {
        name,
        style: $("#preferredStyle").value || userData.settings.style,
        palette: ($('input[name="palette"]:checked') || {}).value || "neutral"
      };
      if (!isSettingsValid(settings)) {
        notify("مقادیر تنظیمات معتبر نیستند.");
        return;
      }
      void saveUserPreferences(settings);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        closeDeleteGarmentConfirmation();
        closeGarmentModal();
        setSidebarOpen(false);
      }
    });
    window.addEventListener("hashchange", () => setActiveView(window.location.hash.slice(1) || "dashboard", false));
  }

  function initializePersonalApp() {
    state = { garments: [], outfits: [] };
    userData = { settings: defaultSettings() };
    applyPalette();
    renderAll();
    ensureDeleteGarmentConfirmation();
    initEvents();
    const initialView = window.location.hash.slice(1);
    setActiveView(initialView || "dashboard", false);
    fetchServerGarments();
    calendarCsrfToken = getCsrfToken();
    lastCalendarRefreshAt = Date.now();
    refreshCalendarData(false);
    personalAppInitialized = true;
    void fetchUserPreferences();
  }

  function init() {
    installIdentityEvents();
    void verifyCurrentUser();
  }

  init();
})();
