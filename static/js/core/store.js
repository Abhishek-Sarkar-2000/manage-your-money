/* ---------- Storage layer ----------
   Talks to the local Flask backend (app.py), which persists everything
   per-signed-in-user in a database (money.db locally, or Turso in prod).

   A 401 mid-use (cookie expired, server restarted, etc.) surfaces here and
   is broadcast as a DOM event — each page decides what "session expired"
   means for itself instead of this module owning a global render(). */
import { showToast } from '../components/toast.js';

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

export const Store = {
  async get(key, fallback) {
    try {
      // 1. Check local session cache first to bypass network completely
      const cached = sessionStorage.getItem(key);
      if (cached) return JSON.parse(cached);

      // 2. Fetch from backend if missing
      const res = await fetch('/api/storage/' + encodeURIComponent(key));
      if (res.status === 401) { onAuthRequired(); return fallback; }
      if (res.status === 404) return fallback;
      if (!res.ok) throw new Error('GET failed: ' + res.status);
      
      const body = await res.json();
      const value = JSON.parse(body.value);
      
      // 3. Save to cache for next time
      sessionStorage.setItem(key, JSON.stringify(value));
      return value;
    } catch (e) {
      console.error('storage get failed', key, e);
      showToast('Could not reach the server — is app.py running?');
      return fallback;
    }
  },

  // NEW: Fetch multiple keys in a single HTTP request to prevent N+1 queries
  async bulkGet(keys, fallback = {}) {
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

      // Fetch only the missing keys
      const res = await fetch('/api/storage/bulk', {
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
      console.error('storage bulk get failed', e);
      showToast('Could not fetch bulk data.');
      return fallback;
    }
  },

  // inside set(key, value):
  async set(key, value) {
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
      console.error('storage set failed', key, e);
      showToast('Could not save to server — check your connection');
      return false;
    } finally {
      pendingWrites--;
    }
  },

  async remove(key) {
    try {
      const res = await fetch('/api/storage/' + encodeURIComponent(key), { method: 'DELETE' });
      if (res.status === 401) { onAuthRequired(); return false; }
      if (!res.ok) throw new Error('DELETE failed: ' + res.status);
      
      // Clear from cache
      sessionStorage.removeItem(key);
      return true;
    } catch (e) {
      console.error('storage delete failed', key, e);
      showToast('Could not delete — is app.py running?');
      return false;
    }
  }
};