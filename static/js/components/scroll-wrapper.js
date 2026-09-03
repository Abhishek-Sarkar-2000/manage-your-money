/* ---------- Reusable horizontal scroll wrapper ---------- */
export function scrollWrapper(trackHtml, trackClass = '') {
  return `
  <div class="scroll-wrapper" data-scroll-wrapper>
    <div class="scroll-track ${trackClass}" data-scroll-track>${trackHtml}</div>
    <button class="scroll-arrow left" data-scroll-prev type="button" aria-label="Scroll left" style="display:none;">←</button>
    <button class="scroll-arrow" data-scroll-next type="button" aria-label="Scroll right">→</button>
  </div>`;
}

export function setupScrollWrappers(root = document) {
  root.querySelectorAll('[data-scroll-wrapper]').forEach(w => {
    const track = w.querySelector('[data-scroll-track]');
    const nextArrow = w.querySelector('[data-scroll-next]');
    const prevArrow = w.querySelector('[data-scroll-prev]');
    if (!track) return;

    const checkScroll = () => {
      const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
      const canScrollLeft = track.scrollLeft > 5;
      const canScrollRight = maxScroll > 5 && track.scrollLeft < maxScroll - 5;

      if (prevArrow) prevArrow.style.display = canScrollLeft ? 'flex' : 'none';
      if (nextArrow) nextArrow.style.display = canScrollRight ? 'flex' : 'none';

      track.classList.toggle('can-scroll-left', canScrollLeft && !canScrollRight);
      track.classList.toggle('can-scroll-right', canScrollRight && !canScrollLeft);
      track.classList.toggle('can-scroll-both', canScrollLeft && canScrollRight);
    };

    track.addEventListener('scroll', checkScroll, { passive: true });
    const resizeObserver = new ResizeObserver(checkScroll);
    resizeObserver.observe(track);
    setTimeout(checkScroll, 50);

    if (nextArrow) nextArrow.addEventListener('click', () => track.scrollBy({ left: 300, behavior: 'smooth' }));
    if (prevArrow) prevArrow.addEventListener('click', () => track.scrollBy({ left: -300, behavior: 'smooth' }));
  });
}

export function setupTableScrollIndicators(root = document) {
  root.querySelectorAll('.table-wrap').forEach(wrap => {
    let shell = wrap.parentElement;
    if (!shell || !shell.classList.contains('table-scroll-shell')) {
      shell = document.createElement('div');
      shell.className = 'table-scroll-shell';
      wrap.parentNode.insertBefore(shell, wrap);
      shell.appendChild(wrap);
    }

    const container = wrap.closest('.transactions-container');
    const stickyWrap = container ? container.querySelector('.sticky-controls-wrap') : null;

    const checkScroll = () => {
      const maxScroll = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      const canScrollLeft = wrap.scrollLeft > 5;
      const canScrollRight = maxScroll > 5 && wrap.scrollLeft < maxScroll - 5;
      
      shell.classList.toggle('can-scroll-left', canScrollLeft);
      shell.classList.toggle('can-scroll-right', canScrollRight);
      shell.classList.toggle('can-scroll-both', canScrollLeft && canScrollRight);
      
      if (stickyWrap) {
        stickyWrap.classList.toggle('can-scroll-left', canScrollLeft);
        stickyWrap.classList.toggle('can-scroll-right', canScrollRight);
      }
    };

    wrap.addEventListener('scroll', checkScroll, { passive: true });
    const resizeObserver = new ResizeObserver(checkScroll);
    resizeObserver.observe(wrap);
    setTimeout(checkScroll, 50);
  });
}
