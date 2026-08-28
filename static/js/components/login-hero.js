/* ---------- Guest-mode banner ----------
   Guests can use every view against localStorage now, so this is no longer
   a full-screen gate — it's a small "back up your data" strip that
   page-chrome.js mounts into every non-shared page when there's no
   signed-in user. */
import { renderGoogleButton } from '../core/auth.js';

export function guestBannerHtml() {
  return `
  <div class="guest-banner" role="note">
    <div class="guest-banner-text">
      <strong>You're using LedgerNote as a guest.</strong>
      Everything you enter here is stored only in this browser. Clearing your
      browser data, switching devices, or reinstalling will permanently erase
      it. Sign in to back it up safely.
    </div>
    <div id="guest-banner-signin-slot" class="guest-banner-signin"></div>
  </div>
  `;
}

export function mountGuestBanner(container) {
  if (!container) return;
  container.innerHTML = guestBannerHtml();
  renderGoogleButton(document.getElementById('guest-banner-signin-slot'), {
    type: 'standard',
    theme: 'filled_blue',
    size: 'medium',
    shape: 'pill',
    text: 'signin_with',
    logo_alignment: 'left',
    width: '220',
  });
}