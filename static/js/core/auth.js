/* ---------- Auth ----------
   Loaded on every route via base.html. Owns the persistent auth-bar chrome
   (Google sign-in button / profile badge) that lives outside each page's
   view root, so it never flickers when a view re-renders its own content.

   Views that need to react to sign-in/out listen for the 'auth:signed-in'
   and 'auth:required' events dispatched on window, rather than this module
   calling into per-page render logic directly. */
import { AppConfig } from './config.js';
import { showToast } from '../components/toast.js';
import { Store } from './store.js';

// App-specific localStorage keys guest mode writes to (kept in sync with
// every Store.get/set key used across static/js/views/*.js).
const GUEST_STATIC_KEYS = [
  'creditcards', 'months-index', 'emiseries', 'sipseries', 'splits-index',
  'custom-spend-tags', 'existinginvestments',
];

function isGuestDataKey(key) {
  return GUEST_STATIC_KEYS.includes(key) || key.startsWith('month:') || key.startsWith('split:');
}

/* Runs once, immediately after a brand-new signup (never for a returning
   user). Walks localStorage for the app's own guest-mode keys, pushes each
   one to the now-authenticated backend via Store.set — which, now that
   currentUser is populated, talks to /api/storage/* instead of
   localStorage — and only clears a key locally once that write succeeds.
   If anything fails partway through, the untouched keys simply stay in
   localStorage and nothing is lost. */
async function migrateGuestDataToCloud() {
  const keysToMigrate = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && isGuestDataKey(key)) keysToMigrate.push(key);
  }
  if (keysToMigrate.length === 0) return;

  let migratedCount = 0;
  for (const key of keysToMigrate) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      const value = JSON.parse(raw);
      const ok = await Store.set(key, value);
      if (ok) {
        localStorage.removeItem(key);
        migratedCount++;
      }
    } catch (e) {
      console.error('Failed to migrate guest key to cloud', key, e);
    }
  }

  if (migratedCount > 0) {
    showToast(`Backed up ${migratedCount} local item${migratedCount === 1 ? '' : 's'} from this device to your account.`);
  }
}

export let currentUser = null;

export async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const body = await res.json();
    currentUser = body.authenticated ? body.user : null;
  } catch (e) {
    console.error('auth check failed', e);
    currentUser = null;
  }
  updateProfileBadge();
  window.dispatchEvent(new CustomEvent('auth:checked', { detail: currentUser }));
  return currentUser;
}

export const authReady = checkAuth();

export async function signOut() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    console.error('logout request failed', e);
  }
  if (window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
  currentUser = null;
  updateProfileBadge();
  showToast('Signed out');
  
  // Full navigation: fresh page load means fresh, correctly-signed-out state
  window.location.href = '/home';
}

async function handleGoogleCredential(response) {
  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(body.error || 'Sign-in failed, please try again');
      return;
    }
    currentUser = body.user;
    updateProfileBadge();
    showToast(`Welcome, ${(body.user.name || '').split(' ')[0] || 'there'}!`);

    // New signup: the guest's local data is the only copy that exists
    // anywhere, so migrate it up and clear it locally once confirmed saved.
    // Returning user: their cloud data is authoritative — leave
    // localStorage exactly as it is, so it's still there if they sign out.
    if (body.isNewUser) {
      await migrateGuestDataToCloud();
    }

    window.dispatchEvent(new CustomEvent('auth:signed-in', { detail: currentUser }));
  } catch (e) {
    console.error('Google sign-in failed', e);
    showToast('Sign-in failed — check your connection.');
  }
}

let isGoogleInitialized = false;

export function renderGoogleButton(container, opts) {
  if (!container) return;

  // Wait for Google SDK to load AND for google.accounts.id.initialize to complete
  if (!window.google?.accounts?.id || !isGoogleInitialized) {
    setTimeout(() => renderGoogleButton(container, opts), 100);
    return;
  }

  // Clear any existing content in this slot, then render
  container.innerHTML = '';
  google.accounts.id.renderButton(container, opts);
}

export function initGoogleSignIn() {
  if (!window.google?.accounts?.id) {
    setTimeout(initGoogleSignIn, 100);
    return;
  }
  if (!AppConfig.googleClientId) {
    console.warn('GOOGLE_CLIENT_ID is not configured on the server.');
    return;
  }

  google.accounts.id.initialize({
    client_id: AppConfig.googleClientId,
    callback: handleGoogleCredential,
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  isGoogleInitialized = true;

  const cornerEl = document.getElementById('google-signin-btn');
  const mobileLoginBtn = document.getElementById('mobile-login-btn');
  
  if (cornerEl) {
    const renderCornerButton = () => {
      const isMobile = window.matchMedia('(max-width: 639px)').matches;
      if (isMobile) {
        cornerEl.style.display = 'none';
        if (mobileLoginBtn) {
          mobileLoginBtn.style.display = currentUser ? 'none' : 'flex';
        }
      } else {
        cornerEl.style.display = currentUser ? 'none' : 'inline-block';
        if (mobileLoginBtn) mobileLoginBtn.style.display = 'none';
        renderGoogleButton(cornerEl, {
          type: 'standard',
          theme: 'outline',
          size: 'medium',
          shape: 'pill',
          text: 'signin_with',
          logo_alignment: 'left',
          width: '200',
        });
      }
    };
    
    renderCornerButton();
    window.matchMedia('(max-width: 639px)').addEventListener('change', renderCornerButton);
  }
}

export function mountHeroGoogleButton(heroSlot) {
  if (!heroSlot) return;

  // 1. Hide corner button so we don't display duplicate login prompts
  const cornerBtn = document.getElementById('google-signin-btn');
  if (cornerBtn) {
    cornerBtn.style.display = 'none';
  }

  // 2. Render Google button directly into the hero container
  renderGoogleButton(heroSlot, {
    type: 'standard', 
    theme: 'filled_blue', 
    size: 'large', 
    shape: 'pill',
    text: 'signin_with', 
    logo_alignment: 'left', 
    width: '280',
  });
}

function updateProfileBadge() {
  const signinEl = document.getElementById('google-signin-btn');
  const badgeEl = document.getElementById('profile-badge');
  const menuEl = document.getElementById('profile-menu');
  const brandNameEl = document.getElementById('brand-name');
  if (!signinEl || !badgeEl) return;

  const burgerBtn = document.getElementById('burger-menu-btn');
  const emailEl = document.getElementById('profile-menu-email');
  const signoutBtn = document.getElementById('profile-signout-btn');
  const themeDivider = document.getElementById('pm-theme-divider');

  if (currentUser) {
    if (brandNameEl) {
      const isHome = window.location.pathname === '/' || window.location.pathname === '/home';
      if (isHome) {
        const firstName = (currentUser.name || '').split(' ')[0] || 'User';
        brandNameEl.textContent = `${firstName}'s LedgerNote`;
      } else {
        brandNameEl.textContent = 'LedgerNote';
      }
    }
    const isMobile = window.matchMedia('(max-width: 639px)').matches;
    const mobileLoginBtn = document.getElementById('mobile-login-btn');
    if (isMobile) {
      signinEl.style.display = 'none';
      if (mobileLoginBtn) mobileLoginBtn.style.display = 'none';
    } else {
      signinEl.hidden = true;
      signinEl.style.display = 'none';
    }
    badgeEl.hidden = false;
    if (burgerBtn) burgerBtn.hidden = false;
    if (emailEl) emailEl.style.display = 'block';
    if (signoutBtn) signoutBtn.style.display = 'block';
    const signinBtn = document.getElementById('profile-signin-btn');
    if (signinBtn) signinBtn.style.display = 'none';
    if (themeDivider) themeDivider.style.display = 'block';
    const avatar = document.getElementById('profile-avatar');
    if (avatar) {
      avatar.onerror = () => { avatar.style.display = 'none'; };
      avatar.style.visibility = 'visible';
      if (currentUser.picture) {
        avatar.style.display = '';
        avatar.src = currentUser.picture;
      } else {
        avatar.style.display = 'none';
      }
      avatar.alt = currentUser.name || '';
    }
    if (emailEl) emailEl.textContent = currentUser.email || '';
  } else {
    if (brandNameEl) {
      brandNameEl.textContent = 'LedgerNote';
    }
    const isMobile = window.matchMedia('(max-width: 639px)').matches;
    const mobileLoginBtn = document.getElementById('mobile-login-btn');
    if (isMobile) {
      signinEl.style.display = 'none';
      if (mobileLoginBtn) mobileLoginBtn.style.display = 'flex';
    } else {
      signinEl.hidden = false;
      signinEl.style.display = 'inline-block';
      if (mobileLoginBtn) mobileLoginBtn.style.display = 'none';
    }
    badgeEl.hidden = true;
    if (burgerBtn) burgerBtn.hidden = false;
    if (emailEl) emailEl.style.display = 'none';
    if (signoutBtn) signoutBtn.style.display = 'none';
    const signinBtn = document.getElementById('profile-signin-btn');
    if (signinBtn) signinBtn.style.display = 'block';
    if (themeDivider) themeDivider.style.display = 'none';
    if (menuEl) menuEl.classList.remove('show');
  }
}

function wireAuthBar() {
  const badgeBtn = document.getElementById('profile-badge-btn');
  const burgerBtn = document.getElementById('burger-menu-btn');
  const menuEl = document.getElementById('profile-menu');
  const signoutBtn = document.getElementById('profile-signout-btn');
  const signinBtn = document.getElementById('profile-signin-btn');
  const mobileLoginBtn = document.getElementById('mobile-login-btn');

  if (signinBtn) {
    signinBtn.addEventListener('click', () => {
      window.location.href = '/home';
    });
  }

  const toggleMenu = (ev) => {
    ev.stopPropagation();
    if (!menuEl) return;
    const willOpen = !menuEl.classList.contains('show');
    menuEl.classList.toggle('show', willOpen);
    if (badgeBtn) badgeBtn.setAttribute('aria-expanded', String(willOpen));
    if (burgerBtn) burgerBtn.setAttribute('aria-expanded', String(willOpen));
    if (mobileLoginBtn) mobileLoginBtn.setAttribute('aria-expanded', String(willOpen));
  };

  if (badgeBtn) badgeBtn.addEventListener('click', toggleMenu);
  if (burgerBtn) burgerBtn.addEventListener('click', toggleMenu);
  if (mobileLoginBtn) mobileLoginBtn.addEventListener('click', toggleMenu);

  document.addEventListener('click', (ev) => {
    const authControls = document.getElementById('auth-controls');
    if (authControls && !authControls.contains(ev.target)) {
      if (menuEl) menuEl.classList.remove('show');
      if (badgeBtn) badgeBtn.setAttribute('aria-expanded', 'false');
      if (burgerBtn) burgerBtn.setAttribute('aria-expanded', 'false');
    }
  });

  if (signoutBtn) {
    signoutBtn.addEventListener('click', () => signOut());
  }
}

function initThemeSelector() {
  const allThemeBtns = () => document.querySelectorAll('[data-theme-btn]');

  function syncActiveStates() {
    const theme = localStorage.getItem('ledger-theme') || 'default';
    allThemeBtns().forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeBtn === theme);
    });
  }

  document.addEventListener('click', (ev) => {
    const themeBtn = ev.target.closest('[data-theme-btn]');
    if (themeBtn) {
      const theme = themeBtn.dataset.themeBtn;
      localStorage.setItem('ledger-theme', theme);
      document.documentElement.setAttribute('data-theme', theme);
      
      const themeColors = { 'default': '#FCFDFF', 'dark': '#0F111E', 'hi-contrast': '#FFFFFF' };
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = themeColors[theme] || '#FCFDFF';

      syncActiveStates();
      
      const profileMenu = document.getElementById('profile-menu');
      const profileBtn = document.getElementById('profile-badge-btn');
      const burgerBtn = document.getElementById('burger-menu-btn');
      
      if (profileMenu) profileMenu.classList.remove('show');
      if (profileBtn) profileBtn.setAttribute('aria-expanded', 'false');
      if (burgerBtn) burgerBtn.setAttribute('aria-expanded', 'false');
    }
  });

  syncActiveStates();
}

window.addEventListener('auth:required', () => {
  showToast('Your session expired — please sign in again.');
  currentUser = null;
  updateProfileBadge();
});

initThemeSelector();
wireAuthBar();