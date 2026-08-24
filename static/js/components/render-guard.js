/* ---------- First-render tracking ----------
   The CSS 'fadeInUp' mount animation on cards/panels should only play once,
   the first time a route paints. Every view calls markRendered(root) right
   before it rebuilds its innerHTML; from the second call onward it adds
   'no-entrance-anim' to the (persistent) root element, which the shared
   CSS override in base.css uses to zero out the animation for re-renders
   triggered by clicks (opening a form, toggling a checkbox, etc). */
export function markRendered(root) {
  const isFirst = !root.dataset.rendered;
  root.dataset.rendered = '1';
  if (!isFirst) root.classList.add('no-entrance-anim');
  return isFirst;
}
