const TABLET_BREAKPOINT = '(max-width: 1023px)';

function getShellElements() {
  return {
    shell: document.getElementById('app-shell'),
    sidebar: document.getElementById('app-sidebar'),
    toggle: document.getElementById('sidebar-toggle-btn'),
    close: document.getElementById('sidebar-close-btn'),
    backdrop: document.getElementById('sidebar-backdrop'),
  };
}

function isDrawerMode() {
  return window.matchMedia(TABLET_BREAKPOINT).matches;
}

export function initAppShell() {
  const {
    shell,
    sidebar,
    toggle,
    close,
    backdrop,
  } = getShellElements();

  if (!shell || !sidebar || !toggle) return;

  let lastFocusedElement = null;

  function openSidebar() {
    if (!isDrawerMode()) return;

    lastFocusedElement = document.activeElement;

    shell.classList.add('sidebar-open');
    document.body.classList.add('sidebar-drawer-open');

    toggle.setAttribute('aria-expanded', 'true');
    sidebar.setAttribute('aria-hidden', 'false');

    requestAnimationFrame(() => {
      const firstFocusable = sidebar.querySelector(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );

      firstFocusable?.focus();
    });
  }

  function closeSidebar({ restoreFocus = true } = {}) {
    shell.classList.remove('sidebar-open');
    document.body.classList.remove('sidebar-drawer-open');

    toggle.setAttribute('aria-expanded', 'false');

    if (isDrawerMode()) {
      sidebar.setAttribute('aria-hidden', 'true');
    } else {
      sidebar.setAttribute('aria-hidden', 'false');
    }

    if (restoreFocus && lastFocusedElement instanceof HTMLElement) {
      lastFocusedElement.focus();
    }

    lastFocusedElement = null;
  }

  function syncResponsiveState() {
    if (!isDrawerMode()) {
      shell.classList.remove('sidebar-open');
      document.body.classList.remove('sidebar-drawer-open');

      toggle.setAttribute('aria-expanded', 'false');
      sidebar.setAttribute('aria-hidden', 'false');
      return;
    }

    if (!shell.classList.contains('sidebar-open')) {
      sidebar.setAttribute('aria-hidden', 'true');
    }
  }

  toggle.addEventListener('click', () => {
    if (shell.classList.contains('sidebar-open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  close?.addEventListener('click', () => closeSidebar());

  backdrop?.addEventListener('click', () => closeSidebar());

  sidebar.addEventListener('click', (event) => {
    const navigationLink = event.target.closest('.sidebar-link');

    if (navigationLink && isDrawerMode()) {
      closeSidebar({ restoreFocus: false });
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!shell.classList.contains('sidebar-open')) return;

    event.preventDefault();
    closeSidebar();
  });

  /*
   * Lightweight focus containment.
   * Prevent keyboard users from tabbing into obscured page content while
   * the off-canvas drawer is open.
   */
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    if (!isDrawerMode()) return;
    if (!shell.classList.contains('sidebar-open')) return;

    const focusable = [
      ...sidebar.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), ' +
        'select:not([disabled]), textarea:not([disabled]), ' +
        '[tabindex]:not([tabindex="-1"])'
      )
    ].filter(el => !el.hasAttribute('hidden'));

    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const breakpoint = window.matchMedia(TABLET_BREAKPOINT);

  if (breakpoint.addEventListener) {
    breakpoint.addEventListener('change', syncResponsiveState);
  } else {
    breakpoint.addListener(syncResponsiveState);
  }

  syncResponsiveState();
}

initAppShell();