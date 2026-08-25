/* ---------- Signed-out landing ----------
   Any authenticated view calls this instead of its normal render when
   core/auth.js reports no signed-in user. */
import { mountHeroGoogleButton } from '../core/auth.js';

export function loginHeroHtml() {
  return `
  <div class="topbar-login">
    <div class="brand-line">
      <div class="brand-login">
        <span class="mark">₹</span>
        <div class="brand-login-text">
          <span class="brand-login-name">LedgerNote</span>
          <div class="eyebrow">Personal finance, kept plainly</div>
        </div>
      </div>
    </div>
    <div class="hero login-hero">
      <div class="hero-signin-text">
        <h1>Manage your money <em>(made easy)</em></h1>
        <p>Log what comes in and what goes out, track what's lent, owed and invested, split group spends with friends — all synced privately to your Google account.</p>
      </div>
      <div id="hero-google-signin-slot" class="hero-google-signin-btn"></div>
      <div class="login-hero-note">Your Google account is used only to keep your data yours — sign in to continue.</div>
    </div>
  </div>
  `;
}

export function mountLoginHero(root) {
  const tb = document.getElementById('global-topbar');
  if (tb) tb.style.display = 'none';

  root.innerHTML = loginHeroHtml();
  mountHeroGoogleButton(document.getElementById('hero-google-signin-slot'));
}
