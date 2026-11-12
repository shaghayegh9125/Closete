(function () {
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  const mobileNav = qs("#mobileNav");
  const mobileMenuButton = qs('.menu-toggle[data-open="#mobileNav"]');
  const overlay = qs("[data-overlay]");

  function setMobileNavOpen(isOpen, focusTarget, returnFocus) {
    if (!mobileNav || !mobileMenuButton) return;

    const wasOpen = mobileNav.classList.contains("is-open");
    const focusIsInNav = mobileNav.contains(document.activeElement);
    const focusIsOnTrigger = document.activeElement === mobileMenuButton;

    if (isOpen) {
      mobileNav.inert = false;
      mobileNav.setAttribute("aria-hidden", "false");
      mobileNav.classList.add("is-open");
      mobileMenuButton.setAttribute("aria-expanded", "true");
      document.body.classList.add("drawer-open");
      if (overlay) overlay.classList.add("is-open");

      const firstFocusable = mobileNav.querySelector("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (firstFocusable) {
        window.setTimeout(function () {
          if (mobileNav.classList.contains("is-open")) firstFocusable.focus();
        }, 50);
      }
      return;
    }

    if (wasOpen && returnFocus !== false && (focusIsInNav || focusIsOnTrigger || focusTarget)) {
      (focusTarget || mobileMenuButton).focus();
    } else if (wasOpen && focusIsInNav) {
      document.activeElement.blur();
    }

    mobileNav.classList.remove("is-open");
    mobileNav.inert = true;
    mobileNav.setAttribute("aria-hidden", "true");
    mobileMenuButton.setAttribute("aria-expanded", "false");
    if (overlay) overlay.classList.remove("is-open");
    document.body.classList.remove("drawer-open");
  }

  function closeAll(focusTarget) {
    setMobileNavOpen(false, focusTarget);
    qsa(".is-open").forEach(function (el) {
      if (!el.classList.contains("account-wrap")) {
        el.classList.remove("is-open");
      }
    });
    document.body.classList.remove("drawer-open");
    qsa('[data-open][aria-expanded="true"]').forEach(function (btn) {
      btn.setAttribute("aria-expanded", "false");
    });
  }

  qsa("[data-open]").forEach(function (btn) {
    btn.addEventListener("click", function (event) {
      var target = qs(btn.getAttribute("data-open"));
      if (!target) return;
      if (target !== mobileNav) event.preventDefault();
      if (target === mobileNav && mobileNav.classList.contains("is-open")) {
        closeAll();
        return;
      }
      if (target !== mobileNav && mobileNav && mobileNav.classList.contains("is-open")) {
        setMobileNavOpen(false, null, false);
      }
      qsa(".drawer, .search-layer, .nav-layer, .overlay").forEach(function (el) {
        el.classList.remove("is-open");
      });
      if (target === mobileNav) {
        setMobileNavOpen(true);
      } else {
        target.classList.add("is-open");
        if (overlay && target.classList.contains("drawer")) {
          overlay.classList.add("is-open");
        }
        document.body.classList.add("drawer-open");
        if (btn.hasAttribute("aria-expanded")) {
          btn.setAttribute("aria-expanded", "true");
        }
        var focusable = target.querySelector("input, button, a");
        if (focusable) focusable.focus();
      }
    });
  });

  qsa("[data-close]").forEach(function (btn) {
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      if (event.target === overlay && mobileNav && mobileNav.classList.contains("is-open")) {
        closeAll(mobileMenuButton);
        return;
      }
      closeAll();
    });
  });

  if (mobileNav) {
    mobileNav.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        setMobileNavOpen(false, null, false);
      }
    });
  }

  document.addEventListener("keydown", function (event) {
    if (mobileNav && mobileNav.classList.contains("is-open") && event.key === "Tab") {
      var focusable = qsa("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])", mobileNav)
        .filter(function (el) {
          return !el.disabled && el.getAttribute("aria-hidden") !== "true" &&
            el.getClientRects().length > 0;
        });
      if (focusable.length) {
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !mobileNav.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !mobileNav.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    if (event.key === "Escape") {
      closeAll(mobileNav && mobileNav.classList.contains("is-open") ? mobileMenuButton : null);
    }
  });

  window.addEventListener("resize", function () {
    if (mobileNav && mobileNav.classList.contains("is-open") && window.innerWidth > 980) {
      setMobileNavOpen(false, qs(".brand"));
    }
  });

  var accountBtn = qs("[data-account]");
  if (accountBtn) {
    accountBtn.addEventListener("click", function (event) {
      event.preventDefault();
      accountBtn.parentElement.classList.toggle("is-open");
    });
    document.addEventListener("click", function (event) {
      if (!accountBtn.parentElement.contains(event.target)) {
        accountBtn.parentElement.classList.remove("is-open");
      }
    });
  }
})();
