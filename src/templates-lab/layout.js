(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const workspace = $('reviewWorkspace'), body = $('workspaceBody'), studio = $('reviewStudio'), dock = $('reviewDock');
  const cards = [...document.querySelectorAll('.studio-window')];
  const key = 'babel-template-lab-layout-v1';
  const mobile = () => matchMedia('(max-width: 760px)').matches;
  const clamp = (value, min, max) => Math.max(min, Math.min(Math.max(min, max), value));
  const heights = { prompts: 340, context: 260, published: 300, tuned: 260 };
  let activeSection = 'dashboard', width = 520, sequence = 10, dragging = null, persistTimer;
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch (_) {}
  if (Number.isFinite(saved?.width)) width = clamp(saved.width, 360, 900);

  function announce(text) { $('layoutAnnouncement').textContent = text; }
  function setSection(section, updateHash = true) {
    activeSection = section === 'templates' ? 'templates' : 'dashboard';
    $('dashboardSection').hidden = activeSection !== 'dashboard';
    $('templatesSection').hidden = activeSection !== 'templates';
    document.querySelectorAll('[data-section]').forEach(button => {
      if (button.dataset.section === activeSection) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (updateHash) history.replaceState(null, '', '#' + activeSection);
  }
  document.querySelectorAll('[data-section]').forEach(button => button.addEventListener('click', () => setSection(button.dataset.section)));
  window.addEventListener('hashchange', () => setSection(location.hash.slice(1), false));
  setSection(location.hash.slice(1), false);
  const settings = $('labSettingsDialog');
  // Older installed Review Helper builds inject this panel into the page body.
  // Move the actual node so its extension listeners and key storage keep working.
  function keepKeyPanelInSettings() {
    const host = $('labSettingsKeyHost');
    for (const input of document.querySelectorAll('input[aria-label="OpenRouter API key"]')) {
      const panel = input.closest('section.bui-card');
      if (!panel || host.contains(panel)) continue;
      const wrapper = panel.parentElement;
      if (host.querySelector('input[aria-label="OpenRouter API key"]')) panel.remove();
      else host.append(panel);
      if (wrapper?.parentElement === document.body && !wrapper.childElementCount && !wrapper.textContent.trim()) wrapper.remove();
    }
    if (host.querySelector('input[aria-label="OpenRouter API key"]')) {
      host.dataset.labKeyMounted = 'true';
      $('labKeyUnavailable').hidden = true;
    }
  }
  keepKeyPanelInSettings();
  new MutationObserver(keepKeyPanelInSettings).observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll('[data-open-settings]').forEach(button => button.addEventListener('click', () => settings.showModal()));
  $('closeLabSettings').addEventListener('click', () => settings.close());
  settings.addEventListener('click', event => {
    const rect = settings.getBoundingClientRect();
    if (event.target === settings && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) settings.close();
  });

  function setWidth(value) {
    width = clamp(value, 360, Math.min(900, body.clientWidth - 280));
    body.style.setProperty('--studio-width', width + 'px');
    $('studioResize').setAttribute('aria-valuenow', String(Math.round(width)));
    $('studioResize').setAttribute('aria-valuemax', String(Math.max(360, Math.min(900, body.clientWidth - 280))));
  }
  function openReview() {
    studio.hidden = false; body.classList.add('review-open');
    $('toggleReview').setAttribute('aria-expanded', 'true');
    if ($('layoutPreset').value === 'focus') $('layoutPreset').value = 'review';
    setWidth(width); confineWindows();
    syncMobileFocus();
    if (mobile()) $('closeReview').focus();
  }
  function closeReview(returnFocus = false) {
    if (!studio.hidden) persist();
    studio.hidden = true; body.classList.remove('review-open');
    $('toggleReview').setAttribute('aria-expanded', 'false');
    $('layoutPreset').value = 'focus';
    $('archivePane').inert = false;
    if (returnFocus) $('toggleReview').focus();
  }
  $('toggleReview').addEventListener('click', () => studio.hidden ? openReview() : closeReview(true));
  $('closeReview').addEventListener('click', () => closeReview(true));
  workspace.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !studio.hidden && !settings.open) {
      event.preventDefault(); $('runReplay').click();
    }
  });
  function syncMobileFocus() {
    $('archivePane').inert = mobile() && !studio.hidden;
  }

  function persist() {
    if (mobile() || !workspace.open || studio.hidden || dragging || !restored) return;
    const order = [...dock.children].filter(node => node.matches('.studio-window')).map(node => node.dataset.windowId);
    const windows = Object.fromEntries(cards.map(card => [card.dataset.windowId, {
      floating: card.classList.contains('is-floating'), collapsed: card.classList.contains('is-collapsed'),
      x: parseFloat(card.style.left) || 0, y: parseFloat(card.style.top) || 0,
      width: parseFloat(card.style.width) || 440,
      height: card.classList.contains('is-collapsed') ? Number(card.dataset.expandedHeight) || heights[card.dataset.windowId] : card.offsetHeight || parseFloat(card.style.height) || heights[card.dataset.windowId]
    }]));
    saved = { width, order, windows };
    try { localStorage.setItem(key, JSON.stringify(saved)); }
    catch (_) { announce('Your browser could not save the layout. It will last for this page only.'); }
  }
  function schedulePersist() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 250); }
  function cardName(card) { return card.querySelector('.window-title').textContent.replace(/^\d+\s*/, '').trim(); }
  function floatCard(card, position = {}) {
    if (mobile()) { announce('Panels stay stacked on small screens.'); return; }
    const rect = body.getBoundingClientRect();
    const old = card.getBoundingClientRect();
    const w = clamp(position.width || 460, 300, rect.width - 24);
    const height = clamp(position.height || old.height || heights[card.dataset.windowId], 160, rect.height - 24);
    card.classList.add('is-floating'); body.append(card);
    Object.assign(card.style, {
      left: clamp(position.x ?? 24, 8, rect.width - w - 8) + 'px',
      top: clamp(position.y ?? 24, 8, rect.height - 44) + 'px',
      width: w + 'px', height: height + 'px', zIndex: String(++sequence)
    });
    updateCardControls(card);
  }
  function dockCard(card, before = null) {
    const height = card.offsetHeight;
    card.classList.remove('is-floating'); dock.insertBefore(card, before);
    card.style.cssText = '';
    if (!card.classList.contains('is-collapsed')) card.style.height = Math.max(180, height || heights[card.dataset.windowId]) + 'px';
    updateCardControls(card);
  }
  function updateCardControls(card) {
    const floating = card.classList.contains('is-floating');
    const pop = card.querySelector('[data-window-action="float"], [data-window-action="dock"]');
    pop.dataset.windowAction = floating ? 'dock' : 'float';
    pop.textContent = floating ? '↙' : '↗';
    pop.setAttribute('aria-label', (floating ? 'Dock ' : 'Float ') + cardName(card));
    pop.title = (floating ? 'Dock ' : 'Float ') + cardName(card);
    const collapse = card.querySelector('[data-window-action="collapse"]');
    collapse.textContent = card.classList.contains('is-collapsed') ? '+' : '−';
    collapse.setAttribute('aria-expanded', String(!card.classList.contains('is-collapsed')));
  }
  for (const card of cards) {
    const name = cardName(card);
    card.querySelector('.window-actions').innerHTML = `<button type="button" class="secondary icon-button" data-window-action="float" aria-label="Float ${name}" title="Float panel">↗</button><button type="button" class="secondary icon-button" data-window-action="collapse" aria-label="Collapse or expand ${name}" aria-expanded="true" title="Collapse or expand">−</button><details class="window-menu"><summary aria-label="More ${name} panel controls" title="More panel controls">⋯</summary><div><button type="button" class="secondary" data-window-action="up">Move earlier</button><button type="button" class="secondary" data-window-action="down">Move later</button><button type="button" class="secondary" data-window-action="grow">Make taller</button><button type="button" class="secondary" data-window-action="shrink">Make shorter</button></div></details>`;
    card.style.height = heights[card.dataset.windowId] + 'px';
    card.addEventListener('pointerdown', () => { if (card.classList.contains('is-floating')) card.style.zIndex = String(++sequence); });
    card.addEventListener('click', event => {
      const control = event.target.closest('[data-window-action]');
      if (!control) return;
      const action = control.dataset.windowAction;
      if (action === 'float') floatCard(card);
      if (action === 'dock') dockCard(card);
      if (action === 'collapse') {
        if (card.classList.contains('is-collapsed')) {
          card.classList.remove('is-collapsed'); card.style.height = (Number(card.dataset.expandedHeight) || heights[card.dataset.windowId]) + 'px';
        } else {
          card.dataset.expandedHeight = String(card.offsetHeight); card.classList.add('is-collapsed');
        }
      }
      if (action === 'grow' || action === 'shrink') {
        card.classList.remove('is-collapsed');
        card.style.height = clamp(card.offsetHeight + (action === 'grow' ? 100 : -100), 160, Math.max(300, body.clientHeight - 24)) + 'px';
      }
      if (action === 'up' || action === 'down') {
        if (card.classList.contains('is-floating')) dockCard(card);
        if (action === 'up' && card.previousElementSibling) dock.insertBefore(card, card.previousElementSibling);
        else if (action === 'down' && card.nextElementSibling) dock.insertBefore(card.nextElementSibling, card);
      }
      card.querySelector('.window-menu').open = false;
      updateCardControls(card); persist(); announce(name + ' panel updated.');
    });
    card.querySelector('.window-handle').addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button, summary, details') || mobile()) return;
      const rect = card.getBoundingClientRect();
      dragging = { card, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, moved: false };
      body.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    new ResizeObserver(schedulePersist).observe(card);
  }
  document.addEventListener('pointermove', event => {
    if (!dragging) return;
    const { card } = dragging;
    if (!dragging.moved && Math.hypot(event.clientX - dragging.startX, event.clientY - dragging.startY) < 6) return;
    const rect = body.getBoundingClientRect();
    if (!dragging.moved) {
      const old = card.getBoundingClientRect();
      floatCard(card, { width: old.width, height: old.height });
      dragging.moved = true; body.classList.add('layout-dragging');
      card.classList.add('is-dragging');
    }
    card.style.left = clamp(event.clientX - rect.left - dragging.offsetX, 8, rect.width - card.offsetWidth - 8) + 'px';
    card.style.top = clamp(event.clientY - rect.top - dragging.offsetY, 8, rect.height - 44) + 'px';
    const target = dock.getBoundingClientRect();
    const over = event.clientX >= target.left && event.clientX <= target.right && event.clientY >= target.top && event.clientY <= target.bottom;
    dock.classList.toggle('drop-target', over);
    dock.querySelectorAll('.drop-before').forEach(node => node.classList.remove('drop-before'));
    if (over) {
      const before = [...dock.children].find(node => { const box = node.getBoundingClientRect(); return event.clientY < box.top + box.height / 2; });
      before?.classList.add('drop-before');
      if (event.clientY < target.top + 40) dock.scrollTop -= 12;
      else if (event.clientY > target.bottom - 40) dock.scrollTop += 12;
    }
  });
  function finishDrag(cancelled = false) {
    if (!dragging) return;
    const { card, moved } = dragging;
    if (moved && dock.classList.contains('drop-target') && !cancelled) dockCard(card, dock.querySelector('.drop-before'));
    card.classList.remove('is-dragging'); body.classList.remove('layout-dragging'); dock.classList.remove('drop-target');
    dock.querySelectorAll('.drop-before').forEach(node => node.classList.remove('drop-before'));
    dragging = null;
    if (moved) { persist(); announce(cardName(card) + (card.classList.contains('is-floating') ? ' panel floating. Drag back into the studio to dock.' : ' panel docked.')); }
  }
  document.addEventListener('pointerup', () => finishDrag());
  document.addEventListener('pointercancel', () => finishDrag(true));
  window.addEventListener('blur', () => finishDrag(true));

  function confineWindows() {
    if (!workspace.open || !body.clientWidth) return;
    for (const card of cards.filter(card => card.classList.contains('is-floating'))) {
      if (mobile()) continue;
      card.style.width = clamp(parseFloat(card.style.width) || 460, 300, body.clientWidth - 24) + 'px';
      card.style.left = clamp(parseFloat(card.style.left) || 0, 8, body.clientWidth - card.offsetWidth - 8) + 'px';
      card.style.top = clamp(parseFloat(card.style.top) || 0, 8, body.clientHeight - 44) + 'px';
    }
  }
  function restore() {
    if (saved?.order && Array.isArray(saved.order)) for (const id of saved.order) {
      const card = cards.find(card => card.dataset.windowId === id); if (card) dock.append(card);
    }
    for (const card of cards) {
      const value = saved?.windows?.[card.dataset.windowId];
      if (!value || typeof value !== 'object') continue;
      if (Number.isFinite(value.height)) card.style.height = clamp(value.height, 160, 1000) + 'px';
      if (value.floating && !mobile()) floatCard(card, {
        x: Number.isFinite(value.x) ? value.x : 24, y: Number.isFinite(value.y) ? value.y : 24,
        width: Number.isFinite(value.width) ? value.width : 460, height: Number.isFinite(value.height) ? value.height : 300
      });
      if (value.collapsed) { card.dataset.expandedHeight = String(value.height || heights[card.dataset.windowId]); card.classList.add('is-collapsed'); }
      updateCardControls(card);
    }
  }
  function reset() {
    for (const card of cards) { card.classList.remove('is-collapsed'); dockCard(card); card.style.height = heights[card.dataset.windowId] + 'px'; updateCardControls(card); }
    setWidth(520); openReview(); $('layoutPreset').value = 'review'; persist(); announce('Default review layout restored.');
  }
  $('resetLayout').addEventListener('click', reset);
  $('layoutPreset').addEventListener('change', () => {
    const value = $('layoutPreset').value;
    if (value === 'focus') { closeReview(); return; }
    if (value === 'review') { reset(); return; }
    reset(); $('layoutPreset').value = 'compare';
    if (mobile()) {
      for (const id of ['published', 'tuned']) dock.append(cards.find(card => card.dataset.windowId === id));
      dock.scrollTop = dock.scrollHeight; announce('Scroll through the original and tuned responses.'); return;
    }
    setWidth(Math.min(520, body.clientWidth * .36));
    const available = body.clientWidth - width - 48, sideBySide = available >= 600;
    const w = sideBySide ? available / 2 : Math.max(300, available + 12);
    const height = sideBySide ? body.clientHeight * .62 : (body.clientHeight - 36) / 2;
    for (const [index, id] of ['published', 'tuned'].entries()) {
      floatCard(cards.find(card => card.dataset.windowId === id), {
        x: sideBySide ? 16 + index * (w + 12) : 16,
        y: sideBySide ? Math.max(12, body.clientHeight * .32) : 12 + index * (height + 12), width: w, height
      });
    }
    persist(); announce(sideBySide ? 'Original and tuned responses arranged side by side.' : 'Original and tuned responses stacked beside the studio.');
  });
  let resizeStart;
  const resize = $('studioResize');
  resize.addEventListener('pointerdown', event => {
    if (event.button !== 0 || mobile()) return;
    resizeStart = { x: event.clientX, width }; resize.setPointerCapture(event.pointerId); body.classList.add('layout-resizing'); event.preventDefault();
  });
  resize.addEventListener('pointermove', event => { if (resizeStart) setWidth(resizeStart.width + resizeStart.x - event.clientX); });
  function finishResize() { if (resizeStart) { resizeStart = null; body.classList.remove('layout-resizing'); persist(); } }
  resize.addEventListener('pointerup', finishResize); resize.addEventListener('lostpointercapture', finishResize);
  resize.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setWidth(event.key === 'Home' ? 360 : event.key === 'End' ? 900 : width + (event.key === 'ArrowLeft' ? 32 : -32)); persist();
  });
  window.addEventListener('resize', () => { if (!studio.hidden) { setWidth(width); confineWindows(); } });
  matchMedia('(max-width: 760px)').addEventListener('change', event => {
    if (event.matches) {
      for (const card of cards.filter(card => card.classList.contains('is-floating'))) dockCard(card);
    } else if (workspace.open) {
      restore(); setWidth(width); confineWindows();
    }
    syncMobileFocus();
    if (event.matches && !studio.hidden) $('closeReview').focus();
  });
  let restored = false;
  window.labLayout = {
    openReview, closeReview, saveLayout: persist,
    onTaskOpen() { closeReview(); if (!restored) { restore(); restored = true; } },
    onTaskClose() { finishDrag(true); closeReview(); setSection('dashboard'); },
    syncSection() { setSection(activeSection, false); }
  };
})();
