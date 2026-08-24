/* ---------- Server-provided config ---------- */
export const AppConfig = (() => {
  try {
    return JSON.parse(document.getElementById('app-config')?.textContent || '{}');
  } catch (e) {
    console.error('Could not parse app-config', e);
    return {};
  }
})();
