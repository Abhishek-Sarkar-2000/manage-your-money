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
      showToast("We couldn't sync some of your local data to the cloud. We'll try again later.");
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
    showToast("We couldn't verify your session. Please check your internet connection.");
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
    showToast("We had trouble securely signing you out. Please refresh and try again.");
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
    showToast("Google sign-in failed — please check your internet connection and try again.");
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

  const signinSlot = document.getElementById('google-signin-btn');

  if (signinSlot) {
    signinSlot.style.display = currentUser ? 'none' : 'block';

    if (!currentUser) {
      renderGoogleButton(signinSlot, {
        type: 'standard',
        theme: 'outline',
        size: 'medium',
        shape: 'pill',
        text: 'signin_with',
        logo_alignment: 'left',
        width: '200',
      });
    }
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
  const signoutBtn = document.getElementById('profile-signout-btn');

  const userCard = document.getElementById('sidebar-user-card');
  const userNameEl = document.getElementById('sidebar-user-name');
  const emailEl = document.getElementById('burger-user-email');
  const initialEl = document.getElementById('sidebar-user-initial');

  if (currentUser) {
    const displayName =
      (currentUser.name || '').trim() ||
      (currentUser.email || '').split('@')[0] ||
      'LedgerNote user';

    const firstInitial = displayName.charAt(0).toUpperCase() || 'L';

    if (signinEl) signinEl.style.display = 'none';
    if (signoutBtn) signoutBtn.style.display = 'block';

    if (userCard) userCard.hidden = false;
    if (userNameEl) userNameEl.textContent = displayName;
    if (initialEl) initialEl.textContent = firstInitial;

    if (emailEl) {
      emailEl.textContent = currentUser.email || '';
    }
  } else {
    if (signinEl) signinEl.style.display = 'block';
    if (signoutBtn) signoutBtn.style.display = 'none';

    if (userCard) userCard.hidden = true;
    if (userNameEl) userNameEl.textContent = '';
    if (emailEl) emailEl.textContent = '';
    if (initialEl) initialEl.textContent = 'L';
  }
}

function wireAccountActions() {
  const signoutBtn = document.getElementById('profile-signout-btn');

  if (signoutBtn) {
    signoutBtn.addEventListener('click', () => signOut());
  }
}

function initThemeSelector() {
  // One persisted theme state drives the shared sidebar on every viewport.
  function syncActiveStates() {
    const theme = localStorage.getItem('ledger-theme') || 'default';
    document.querySelectorAll('[data-theme-btn]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeBtn === theme);
    });
  }

  document.addEventListener('click', (ev) => {
    const themeBtn = ev.target.closest('[data-theme-btn]');
    if (themeBtn) {
      const theme = themeBtn.dataset.themeBtn;
      const supportedThemes = ['default', 'hi-contrast', 'dark'];

      if (!supportedThemes.includes(theme)) return;

      localStorage.setItem('ledger-theme', theme);
      document.documentElement.setAttribute('data-theme', theme);

      const themeColors = {
        default: '#FCFDFF',
        'hi-contrast': '#FFFFFF',
        dark: '#0F111E'
      };
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = themeColors[theme] || '#FCFDFF';

      // Re-sync every rendered theme control from the same persisted state.
      syncActiveStates();
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
wireAccountActions();