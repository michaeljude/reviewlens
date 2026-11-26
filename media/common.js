// Shared helpers for the webviews. Builds DOM nodes with textContent only, so diff text is never parsed as HTML.
(function () {
  function el(tag, attrs) {
    const node = document.createElement(tag);
    const a = attrs || {};
    for (const key of Object.keys(a)) {
      const v = a[key];
      if (v === undefined || v === null || v === false) continue;
      if (key === 'class') node.className = v;
      else if (key.startsWith('on') && typeof v === 'function') node.addEventListener(key.slice(2).toLowerCase(), v);
      else if (key === 'checked') node.checked = !!v;
      else if (v === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(v));
    }
    for (let i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) {
      child.forEach((c) => append(node, c));
      return;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  function ago(ts) {
    if (!ts) return '';
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + ' h ago';
    return Math.round(hours / 24) + ' d ago';
  }
  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }
  const RISK = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' };

  // Replaces the page's content without losing what you're doing: scroll positions, the focused text box and its cursor.
  function rerender(root, build) {
    const active = document.activeElement;
    const key = active && active.dataset ? active.dataset.key : undefined;
    const sel = key && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const scrollY = window.scrollY;
    const scrolled = [...root.querySelectorAll('[data-scroll]')].map((n) => [n.dataset.scroll, n.scrollLeft, n.scrollTop]);
    root.replaceChildren();
    build();
    window.scrollTo(0, scrollY);
    for (const [id, left, top] of scrolled) {
      const n = root.querySelector('[data-scroll="' + id + '"]');
      if (n) { n.scrollLeft = left; n.scrollTop = top; }
    }
    if (key) {
      const n = root.querySelector('[data-key="' + CSS.escape(key) + '"]');
      if (n) {
        n.focus({ preventScroll: true });
        if (sel && n.setSelectionRange) n.setSelectionRange(sel[0], sel[1]);
      }
    }
  }

  // A text box whose text is kept in drafts[key], so re-rendering never loses it.
  function textarea(drafts, key, attrs, onChange) {
    const t = el('textarea', Object.assign({ 'data-key': key, rows: 3 }, attrs || {}));
    t.value = drafts[key] || '';
    t.addEventListener('input', () => {
      drafts[key] = t.value;
      if (onChange) onChange(t.value);
    });
    return t;
  }

  window.acr = { el, ago, plural, RISK, rerender, textarea };
})();
