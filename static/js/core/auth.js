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

let googleBtnLocation = null;

export function renderGoogleButton(container, opts) {
  if (!container) return;
  if (!window.google || !window.google.accounts || !window.google.accounts.id) {
    setTimeout(() => renderGoogleButton(container, opts), 250);
    return;
  }
  google.accounts.id.renderButton(container, opts);
}

// FIXED: Added 'export' keyword here
export function initGoogleSignIn() {
  if (!window.google || !window.google.accounts || !window.google.accounts.id) {
    setTimeout(initGoogleSignIn, 250);
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

  const cornerEl = document.getElementById('google-signin-btn');
  if (cornerEl) {
    renderGoogleButton(cornerEl, {
      type: 'standard', theme: 'outline', size: 'medium', shape: 'pill',
      text: 'signin_with', logo_alignment: 'left', width: '200',
    });
    googleBtnLocation = 'corner';
  }
}

export function mountHeroGoogleButton(heroSlot) {
  if (!heroSlot) return;

  // 1. Hide the corner button safely using CSS instead of ripping it out of the DOM
  const cornerBtn = document.getElementById('google-signin-btn');
  if (cornerBtn) {
    cornerBtn.style.display = 'none';
  }

  // 2. Ask Google to render a distinct, fresh button directly into the hero container
  if (googleBtnLocation !== 'hero') {
    renderGoogleButton(heroSlot, {
      type: 'standard', 
      theme: 'filled_blue', 
      size: 'large', 
      shape: 'pill',
      text: 'signin_with', 
      logo_alignment: 'left', 
      width: '280',
    });
    googleBtnLocation = 'hero';
  }
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
    if (menuEl) menuEl.hidden = true;
  }
}

function wireAuthBar() {
  const badgeBtn = document.getElementById('profile-badge-btn');
  const menuEl = document.getElementById('profile-menu');
  const signoutBtn = document.getElementById('profile-signout-btn');

  if (badgeBtn && menuEl) {
    badgeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const willOpen = menuEl.hidden;
      menuEl.hidden = !willOpen;
      badgeBtn.setAttribute('aria-expanded', String(willOpen));
    });
    document.addEventListener('click', (ev) => {
      const badge = document.getElementById('profile-badge');
      if (badge && !badge.contains(ev.target)) {
        menuEl.hidden = true;
        badgeBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }
  if (signoutBtn) {
    signoutBtn.addEventListener('click', () => signOut());
  }
}

window.addEventListener('auth:required', () => {
  showToast('Your session expired — please sign in again.');
  currentUser = null;
  updateProfileBadge();
});

wireAuthBar();