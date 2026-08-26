/* ---------- Auth ----------
   Loaded on every route via base.html. Owns the persistent auth-bar chrome
   (Google sign-in button / profile badge) that lives outside each page's
   view root, so it never flickers when a view re-renders its own content.

   Views that need to react to sign-in/out listen for the 'auth:signed-in'
   and 'auth:required' events dispatched on window, rather than this module
   calling into per-page render logic directly. */
import { AppConfig } from './config.js';
import { showToast } from '../components/toast.js';

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
  if (cornerEl) {
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
  if (!signinEl || !badgeEl) return;

  if (currentUser) {
    signinEl.hidden = true;
    badgeEl.hidden = false;
    const avatar = document.getElementById('profile-avatar');
    const emailEl = document.getElementById('profile-menu-email');
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
    signinEl.hidden = false;
    badgeEl.hidden = true;
    if (menuEl) menuEl.classList.remove('show');
  }
}

function wireAuthBar() {
  const badgeBtn = document.getElementById('profile-badge-btn');
  const menuEl = document.getElementById('profile-menu');
  const signoutBtn = document.getElementById('profile-signout-btn');

  if (badgeBtn && menuEl) {
    badgeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const willOpen = !menuEl.classList.contains('show');
      
      // Close the burger menu if we are opening the profile menu
      if (willOpen) {
        const burgerPanel = document.getElementById('burger-menu-panel');
        const burgerBtn = document.getElementById('burger-menu-btn');
        if (burgerPanel) burgerPanel.classList.remove('show');
        if (burgerBtn) burgerBtn.setAttribute('aria-expanded', 'false');
      }
      
      menuEl.classList.toggle('show', willOpen);
      badgeBtn.setAttribute('aria-expanded', String(willOpen));
    });
    document.addEventListener('click', (ev) => {
      const badge = document.getElementById('profile-badge');
      if (badge && !badge.contains(ev.target)) {
        menuEl.classList.remove('show');
        badgeBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }
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
      syncActiveStates();
      const panel = document.getElementById('burger-menu-panel');
      const burgerBtn = document.getElementById('burger-menu-btn');
      if (panel) panel.classList.remove('show');
      if (burgerBtn) burgerBtn.setAttribute('aria-expanded', 'false');
      return;
    }

    const burgerBtn = ev.target.closest('#burger-menu-btn');
    const panel = document.getElementById('burger-menu-panel');
    if (burgerBtn && panel) {
      const willOpen = !panel.classList.contains('show');
      
      // Close the profile menu if we are opening the burger menu
      if (willOpen) {
        const profileMenu = document.getElementById('profile-menu');
        const profileBtn = document.getElementById('profile-badge-btn');
        if (profileMenu) profileMenu.classList.remove('show');
        if (profileBtn) profileBtn.setAttribute('aria-expanded', 'false');
      }
      
      panel.classList.toggle('show', willOpen);
      burgerBtn.setAttribute('aria-expanded', String(willOpen));
      return;
    }

    if (panel && panel.classList.contains('show') && !ev.target.closest('#burger-menu-panel')) {
      panel.classList.remove('show');
      document.getElementById('burger-menu-btn')?.setAttribute('aria-expanded', 'false');
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