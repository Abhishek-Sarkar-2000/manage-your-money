/* ---------- Shared per-page chrome ----------
   The "back to home" FAB and the privacy footer used to be appended by the
   monolith's single render() after every view. Each page template now owns
   its own <div id="..."-root">; this helper appends the same trailing
   markup so every view keeps the identical footer/FAB/popover-host
   elements without duplicating the HTML in every view module. It also owns
   the guest-mode "back up your data" banner, since every authenticated view
   calls this after rendering. */
import { currentUser } from '../core/auth.js';
import { mountGuestBanner } from './login-hero.js';

export function appendPageChrome(root, { showFabHome = true, isShared = false } = {}) {
  if (showFabHome) {
    root.insertAdjacentHTML('beforeend',
      `<a class="fab-home" href="/home" title="Back to home" aria-label="Back to home">⌂</a>`);
  }
  const footerNote = isShared
    ? "You're viewing a read-only, shared Split Money group."
    : 'Your figures are stored privately and only visible to you.';
  
  let footerContainer = document.getElementById('global-footer-container');
  if (!footerContainer) {
    footerContainer = document.createElement('div');
    footerContainer.id = 'global-footer-container';
    document.body.appendChild(footerContainer);
  }

  footerContainer.innerHTML = `
    <div class="footer-block">
      <p class="privacy-note">${footerNote}</p>
      <div class="page-footer"><span>Don't you squander now ;)</span></div>
    </div>
  `;

  // Guest-mode reminder: never on public/shared pages, never once signed in.
  // Lives as the first child of #app so it picks up the same max-width,
  // centering, and side padding every view's content already uses, instead
  // of sitting full-bleed outside that container.
  let guestBannerContainer = document.getElementById('guest-banner-container');
  if (!isShared && !currentUser) {
    if (!guestBannerContainer) {
      guestBannerContainer = document.createElement('div');
      guestBannerContainer.id = 'guest-banner-container';
      const appEl = document.getElementById('app');
      if (appEl) {
        appEl.insertBefore(guestBannerContainer, appEl.firstChild);
      } else {
        document.body.insertBefore(guestBannerContainer, document.body.firstChild);
      }
    }
    mountGuestBanner(guestBannerContainer);
  } else if (guestBannerContainer) {
    guestBannerContainer.remove();
  }
}