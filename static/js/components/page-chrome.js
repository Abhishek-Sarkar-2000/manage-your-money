/* ---------- Shared per-page chrome ----------
   The "back to home" FAB and the privacy footer used to be appended by the
   monolith's single render() after every view. Each page template now owns
   its own <div id="..."-root">; this helper appends the same trailing
   markup so every view keeps the identical footer/FAB/popover-host
   elements without duplicating the HTML in every view module. */
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
}
