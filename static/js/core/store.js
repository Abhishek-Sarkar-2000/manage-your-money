/* ---------- Storage layer ----------
   Talks to the local Flask backend (app.py), which persists everything
   per-signed-in-user in a database (money.db locally, or Turso in prod).

   A 401 mid-use (cookie expired, server restarted, etc.) surfaces here and
   is broadcast as a DOM event — each page decides what "session expired"
   means for itself instead of this module owning a global render(). */
import { showToast } from '../components/toast.js';
import { currentUser } from './auth.js';

function onAuthRequired() {
  if (document.body.dataset.isShared === 'true') return; // public pages never need a session
  window.dispatchEvent(new CustomEvent('auth:required'));
}


let pendingWrites = 0;

window.addEventListener('beforeunload', (e) => {
  if (pendingWrites > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Small helper: retry a request a couple of times with a short delay before
// giving up on it. Most bulk-fetch failures are a single transient blip (a
// dev server mid-restart, one dropped packet) — retrying quietly clears
// those without ever bothering the user. 401/404 are real answers, not
// failures, so they return immediately without retrying.
async function fetchWithRetry(url, options, attempts = 2, delayMs = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || res.status === 401 || res.status === 404) return res;
      lastErr = new Error('Request failed: ' + res.status);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  throw lastErr;
}

export const Store = {
  async get(key, fallback) {
    // Guest mode: localStorage is the only source of truth, never hit the network.
    if (!currentUser) {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        return JSON.parse(raw);
      } catch (e) {
        showToast("We couldn't load your local data. Your browser storage might be restricted.");
        return fallback;
      }
    }

    try {
      // 1. Check local session cache first to bypass network completely
      const cached = sessionStorage.getItem(key);
      if (cached) return JSON.parse(cached);

      // 2. Fetch from backend if missing
      const res = await fetch('/api/storage/' + encodeURIComponent(key));
      if (res.status === 401) { onAuthRequired(); return fallback; }
      if (res.status === 404) return fallback; // Correct: Month doesn't exist yet
      if (!res.ok) throw new Error('GET failed: ' + res.status);
      
      const body = await res.json();
      const value = JSON.parse(body.value);
      
      // 3. Save to cache for next time
      sessionStorage.setItem(key, JSON.stringify(value));
      return value;
    } catch (e) {
      showToast("Uh oh! We couldn't load your data safely. Please check your internet connection and refresh the page.");
      throw e;
    }
  },

  // NEW: Fetch multiple keys in a single HTTP request to prevent N+1 queries
  async bulkGet(keys, fallback = {}) {
    // Guest mode: pull every key straight out of localStorage, no network call.
    if (!currentUser) {
      const result = {};
      try {
        keys.forEach(k => {
          const raw = localStorage.getItem(k);
          if (raw !== null) result[k] = JSON.parse(raw);
        });
      } catch (e) {
        showToast("We couldn't load your offline data. Please check your browser's storage settings.");
      }
      return result;
    }

    try {
      const missingKeys = [];
      const result = {};

      // Pull whatever we already have from cache
      keys.forEach(k => {
        const cached = sessionStorage.getItem(k);
        if (cached) {
          result[k] = JSON.parse(cached);
        } else {
          missingKeys.push(k);
        }
      });

      // If everything was cached, no network call needed!
      if (missingKeys.length === 0) return result;

      // 1. Try the bulk endpoint, with a couple of quiet retries for transient blips.
      try {
        const res = await fetchWithRetry('/api/storage/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: missingKeys })
        });

        if (res.status === 401) { onAuthRequired(); return fallback; }
        if (!res.ok) throw new Error('Bulk GET failed: ' + res.status);

        const body = await res.json();
        for (const [k, v] of Object.entries(body)) {
          sessionStorage.setItem(k, JSON.stringify(v));
          result[k] = v;
        }
        return result;
      } catch (e) {
        showToast("Network hiccup! We're trying a different way to load your data...");
      }

      // 2. Bulk endpoint is still down — recover by fetching each missing
      // key individually instead of giving up on all of them. This is the
      // same per-key route Store.get() already uses, so it works as long as
      // the server itself is reachable, even if /api/storage/bulk isn't.
      const settled = await Promise.allSettled(
        missingKeys.map(async (k) => {
          const r = await fetch('/api/storage/' + encodeURIComponent(k));
          if (r.status === 401) throw new Error('auth-required');
          if (r.status === 404) return { k, value: undefined };
          if (!r.ok) throw new Error('GET failed: ' + r.status);
          const body = await r.json();
          return { k, value: JSON.parse(body.value) };
        })
      );

      let anySucceeded = false;
      let authRequired = false;
      settled.forEach((s) => {
        if (s.status === 'fulfilled') {
          anySucceeded = true;
          const { k, value } = s.value;
          if (value !== undefined) {
            sessionStorage.setItem(k, JSON.stringify(value));
            result[k] = value;
          }
        } else if (s.reason && s.reason.message === 'auth-required') {
          authRequired = true;
        }
      });

      if (authRequired) { onAuthRequired(); return fallback; }
      if (!anySucceeded) {
        // Only reached if the bulk endpoint AND every individual per-key
        // request failed — a genuine outage, not a one-off blip.
        showToast("We couldn't load your data. Please check your internet connection and try again.");
        return fallback;
      }
      return result;
    } catch (e) {
      showToast("We couldn't load your data. Please check your internet connection and try again.");
      return fallback;
    }
  },

  // inside set(key, value):
 async set(key, value) {
    // Guest mode: persist to localStorage only, no server round trip.
    if (!currentUser) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        showToast("Could not save locally — your browser storage may be full or restricted.");
        return false;
      }
    }

    sessionStorage.setItem(key, JSON.stringify(value));

    pendingWrites++;
    try {
      const res = await fetch('/api/storage/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: JSON.stringify(value) }),
        keepalive: true,
      });
      if (res.status === 401) { onAuthRequired(); return false; }
      if (!res.ok) throw new Error('PUT failed: ' + res.status);
      return true;
    } catch (e) {
      showToast("Yikes, your last change didn't save! Please check your internet connection before adding anything else.");
      return false;
    } finally {
      pendingWrites--;
    }
  },

  async remove(key) {
    // Guest mode: delete straight from localStorage, no server round trip.
    if (!currentUser) {
      try {
        localStorage.removeItem(key);
        return true;
      } catch (e) {
        showToast("Couldn't delete this item locally. Please try again.");
        return false;
      }
    }

    try {
      const res = await fetch('/api/storage/' + encodeURIComponent(key), { method: 'DELETE' });
      if (res.status === 401) { onAuthRequired(); return false; }
      if (!res.ok) throw new Error('DELETE failed: ' + res.status);
      
      // Clear from cache
      sessionStorage.removeItem(key);
      return true;
    } catch (e) {
      showToast("Couldn't delete this item from the server. Please check your connection.");
      return false;
    }
  }
};