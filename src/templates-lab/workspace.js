(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dialog = $('reviewWorkspace');
  const templateHome = $('templateWorkbench').parentNode;
  let task = null, view = 'native', config = null, draft = null, loadId = 0, running = false;
  let activeKind = 'classifier';
  const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const time = value => Number.isFinite(value) ? `${Math.floor(value / 60)}:${(value % 60).toFixed(2).padStart(5, '0')}` : '—';
  function helperCall(operation, body) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const source = 'babel-review-lab-key-v1';
      const listener = event => {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin || data?.source !== source || data.direction !== 'response' || data.requestId !== requestId) return;
        clearTimeout(timer); window.removeEventListener('message', listener);
        if (data.payload?.ok) resolve(data.payload.result); else reject(new Error(data.payload?.error || 'Review Helper request failed.'));
      };
      const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('Review Helper did not respond. Install or reload the updated extension, refresh the Lab, and save your OpenRouter key.')); }, operation === 'ping' ? 1800 : 185000);
      window.addEventListener('message', listener);
      window.postMessage({ source, direction: 'request', requestId, operation, body }, location.origin);
    });
  }
  async function api(url, body) {
    if (url === '/api/templates-lab/replay' && !body?.previewOnly) { await helperCall('ping'); return helperCall('replay', body); }
    const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }
  function status(text, error = false) { $('promptStatus').textContent = text; $('promptStatus').classList.toggle('error', error); }
  function captureDraft() { if (draft) draft[activeKind] = $('systemPrompt').value; }
  function dirty() { captureDraft(); return config && draft && ['classifier', 'grader'].some(kind => draft[kind] !== (config.settings[kind] ?? config.defaults[kind])); }
  function resultHtml(result) {
    const entries = result?.grades || result?.feedback || result?.aiReview?.feedback;
    if (!Array.isArray(entries)) return `<pre>${h(JSON.stringify(result || 'No saved model result.', null, 2))}</pre>`;
    return entries.map(item => `<article class="grade-result"><strong>${h(item.category)}</strong>${result.grades ? `<span class="score">${h(item.score)} / 3</span>` : ''}<p>${h(item.note)}</p>${item.evidence ? `<details><summary>Evidence · ${h(item.evidence.count ?? 0)}</summary><pre>${h(JSON.stringify(item.evidence, null, 2))}</pre></details>` : ''}</article>`).join('');
  }
  function taskCards(items, pinned) {
    return items.map((item, index) => '<article class="task-card"><button type="button" class="recent-task secondary" data-history="' + h(item.historyId) + '"><span class="task-order">' + (pinned ? 'Pinned' : String(index + 1).padStart(2, '0')) + '</span><strong>' + h(item.reviewActionId) + '</strong><span>' + h(new Date(item.loggedAt).toLocaleString()) + '</span><span>' + h(item.originalSegments) + ' → ' + h(item.currentSegments) + ' segments · ' + h(item.eventType.replaceAll('_', ' ')) + '</span><b>Open workspace ↗</b></button><button type="button" class="secondary task-pin" data-pin="' + (pinned ? 'false' : 'true') + '" data-pin-history="' + h(item.historyId) + '" data-action="' + h(item.reviewActionId) + '">' + (pinned ? 'Unpin · return to queue' : 'Pin · hold outside queue') + '</button></article>').join('');
  }
  async function recent() {
    try {
      const { items, pinned = [] } = await api('/api/templates-lab/recent');
      $('recentTasks').innerHTML = items.length ? taskCards(items, false) : '<p>No unpinned checked tasks are available.</p>';
      $('pinnedTasks').innerHTML = taskCards(pinned, true);
      $('pinnedSection').hidden = !pinned.length;
    } catch (error) { $('recentTasks').textContent = 'Could not load recent tasks: ' + error.message; }
  }
  async function taskClick(event) {
    const pin = event.target.closest('[data-pin]');
    if (pin) {
      pin.disabled = true;
      try {
        $('taskListStatus').textContent = '';
        await api('/api/templates-lab/pin', { pinned: pin.dataset.pin === 'true', historyId: pin.dataset.pinHistory, reviewActionId: pin.dataset.action });
        await recent();
      } catch (error) { pin.disabled = false; $('taskListStatus').textContent = error.message; }
      return;
    }
    const button = event.target.closest('[data-history]');
    if (button) openTask(button.dataset.history);
  }
  function transcriptHtml(snapshot, title) {
    const rows = [...snapshot.annotations].sort((a, b) => a.startTimeInSeconds - b.startTimeInSeconds || a.processedRecordingId.localeCompare(b.processedRecordingId));
    const tracks = [...new Set(rows.map(row => row.processedRecordingId))];
    const duration = Math.max(1, ...rows.map(row => row.endTimeInSeconds));
    return `<section class="transcript-version"><h3>${h(title)} <small>Level ${h(snapshot.actionLevel)} · ${rows.length} segments</small></h3><div class="archive-timeline">${tracks.map((track, i) => `<div class="timeline-track"><span>Track ${i + 1}</span><div>${rows.filter(row => row.processedRecordingId === track).map(row => `<a href="#segment-${h(snapshot.actionId)}-${h(row.id)}" title="${h(row.content)}" style="left:${Math.max(0, row.startTimeInSeconds / duration * 100)}%;width:${Math.max(.3, (row.endTimeInSeconds - row.startTimeInSeconds) / duration * 100)}%"></a>`).join('')}</div></div>`).join('')}<p>0:00 <span>${time(duration)}</span></p></div><div class="transcript-table"><div class="transcript-row table-head"><span>Track / time</span><span>Transcript</span></div>${rows.map(row => `<article class="transcript-row" id="segment-${h(snapshot.actionId)}-${h(row.id)}"><span class="segment-time">Track ${tracks.indexOf(row.processedRecordingId) + 1}<small>${time(row.startTimeInSeconds)} – ${time(row.endTimeInSeconds)}</small></span><p>${h(row.content)}</p></article>`).join('')}</div></section>`;
  }
  function fullTextDiff() {
    return (task.textDiff || []).map(track => '<article class="diff-change"><header><strong>' + h(track.label) + '</strong><span>Full transcript text</span></header><div class="diff-pair">' + [-1, 1].map(side => '<div><small>' + (side < 0 ? 'Original' : 'Corrected') + '</small><p class="inline-diff">' + track.parts.filter(part => part[0] !== -side).map(([operation, text]) => operation ? '<mark class="' + (operation < 0 ? 'removed' : 'added') + '">' + h(text) + '</mark>' : h(text)).join('') + '</p></div>').join('') + '</div></article>').join('');
  }
  function playableRecordings() {
    const tracks = new Map();
    for (const recording of [...(task.current.recordings || []), ...(task.original.recordings || [])]) {
      try {
        const url = new URL(recording.processedRecordingUrl);
        if (!url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) && !tracks.has(recording.processedRecordingId)) tracks.set(recording.processedRecordingId, { ...recording, url: url.href });
      } catch (_) {}
    }
    return [...tracks.values()];
  }
  function renderArchive() {
    if (!task) return;
    const audio = playableRecordings();
    $('nativeAudioNotice').textContent = audio.length ? 'Babel recreation · Archived task, read-only · Audio from saved CDN links.' : 'Babel recreation · No audio URL in this snapshot. Capture this task again with the updated Review Helper.';
    document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
    $('nativeArchive').hidden = view !== 'native';
    $('archivePane').classList.toggle('native-pane', view === 'native');
    $('archiveContent').hidden = view === 'templates' || view === 'native';
    if (view === 'native') {
      $('overlayTemplates').hidden = true;
      const frame = $('babelArchiveFrame');
      if (frame.dataset.history !== task.historyId) {
        frame.dataset.history = task.historyId;
        frame.src = '/templates-lab/recreation/archive.html?labHistoryId=' + encodeURIComponent(task.historyId) + '&reviewActionId=' + encodeURIComponent(task.reviewActionId) + '&readOnly=true&displayFeedback=true';
      }
      return;
    }
    $('overlayTemplates').hidden = view !== 'templates';
    if (view === 'templates') { $('overlayTemplates').append($('templateWorkbench')); return; }
    const banner = audio.length ? '<section class="archive-audio"><p class="archive-notice">Saved recording links · If playback fails, the link may have expired; reopen the task in Babel and capture it again.</p>' + audio.map((recording, index) => '<label>Track ' + (index + 1) + '<audio controls preload="none" src="' + h(recording.url) + '"></audio></label>').join('') + '</section>' : '<p class="archive-notice">No audio URL in this snapshot. Capture this task again with the updated Review Helper.</p>';
    if (view === 'transcript') {
      $('archiveContent').innerHTML = banner + transcriptHtml(task.current, 'Corrected transcript') + `<details><summary>Original transcript</summary>${transcriptHtml(task.original, 'Original transcript')}</details>`;
    } else {
      $('archiveContent').innerHTML = banner + `<div class="diff-heading"><h2>Original → corrected</h2><span>${task.changes.length} model evidence changes</span></div>${fullTextDiff()}<details><summary>Model evidence and structural changes</summary><div class="diff-changes">${task.changes.map(change => {
        const evidence = change.evidenceDetail;
        return `<article class="diff-change"><header><span class="change-type">${h(change.type)}</span><strong>${h(change.summary || `Change ${change.index}`)}</strong></header>${evidence?.kind === 'text-diff' ? `<div class="diff-pair"><div><small>Original</small><p class="removed">${h(evidence.before)}</p></div><div><small>Corrected</small><p class="added">${h(evidence.after)}</p></div></div>` : `<p>${h(change.description)}</p>`}</article>`;
      }).join('') || '<p>No changes detected between these snapshots.</p>'}</div></details><details><summary>Compare full transcripts</summary><div class="full-comparison">${transcriptHtml(task.original, 'Original')}${transcriptHtml(task.current, 'Corrected')}</div></details>`;
    }
  }
  async function openTask(historyId) {
    const epoch = ++loadId;
    dialog.showModal(); document.body.classList.add('workspace-open');
    $('archiveContent').textContent = 'Loading archived task…';
    $('systemPrompt').disabled = true;
    try {
      const [detail, settings] = await Promise.all([api(`/api/review-history/${encodeURIComponent(historyId)}`), config ? Promise.resolve(config) : api('/api/templates-lab/prompts')]);
      if (epoch !== loadId || !dialog.open) return;
      task = detail; config = settings;
      draft ||= { classifier: settings.settings.classifier ?? settings.defaults.classifier, grader: settings.settings.grader ?? settings.defaults.grader };
      $('systemPrompt').value = draft[activeKind]; $('systemPrompt').disabled = false;
      $('workspaceTitle').textContent = detail.reviewActionId;
      $('workspaceMeta').textContent = `${new Date(detail.loggedAt).toLocaleString()} · ${detail.eventType.replaceAll('_', ' ')}`;
      $('labModel').textContent = settings.model;
      $('savedResult').innerHTML = resultHtml(detail.aiReview);
      $('replayResult').textContent = 'Run a test to compare your changes.';
      $('promptPreviewText').textContent = ''; renderArchive();
    } catch (error) { $('archiveContent').textContent = `Could not open task: ${error.message}`; task = null; }
  }
  function close() { ++loadId; captureDraft(); templateHome.append($('templateWorkbench')); dialog.close(); document.body.classList.remove('workspace-open'); }
  async function replay(previewOnly) {
    if (!task || running || !draft) return;
    captureDraft(); running = true;
    $('runReplay').disabled = $('previewPrompt').disabled = true;
    const capturedTask = task.historyId, capturedKind = activeKind, capturedPrompt = draft[activeKind];
    const categories = window.templatesLab.getDraft();
    status(previewOnly ? 'Building model input…' : 'Testing draft on the saved task…');
    try {
      const result = await api('/api/templates-lab/replay', { historyId: capturedTask, kind: capturedKind, systemPrompt: capturedPrompt, categories, previewOnly });
      if (task?.historyId !== capturedTask || activeKind !== capturedKind) { status('Test completed for the previous selection. Run again for the current task.'); return; }
      if (previewOnly) { $('promptPreviewText').textContent = `SYSTEM\n${result.prompts.systemPrompt}\n\nUSER\n${result.prompts.userPrompt}`; $('promptPreview').open = true; }
      else $('replayResult').innerHTML = `<p class="panel-sub">${h(capturedKind)} · ${h(result.model)} · ${h(new Date().toLocaleTimeString())}</p>` + resultHtml(result);
      captureDraft();
      const changed = draft[activeKind] !== capturedPrompt || JSON.stringify(window.templatesLab.getDraft()) !== JSON.stringify(categories);
      status(changed ? 'Draft changed during this test. Run again to evaluate the latest edits.' : previewOnly ? 'Model input ready. No model request was made.' : 'Test complete. The archived review is unchanged.');
    } catch (error) { status(error.message, true); }
    finally { running = false; $('runReplay').disabled = $('previewPrompt').disabled = false; }
  }
  $('recentTasks').addEventListener('click', taskClick);
  $('pinnedTasks').addEventListener('click', taskClick);
  $('reloadRecent').addEventListener('click', recent);
  $('overlaySaveTemplates').addEventListener('click', () => $('saveDraftBtn').click());
  $('overlayDiscardTemplates').addEventListener('click', () => $('discardDraftBtn').click());
  $('closeWorkspace').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { view = button.dataset.view; renderArchive(); }));
  $('promptKind').addEventListener('change', () => { captureDraft(); activeKind = $('promptKind').value; if (draft) $('systemPrompt').value = draft[activeKind]; $('promptPreviewText').textContent = ''; $('replayResult').textContent = 'Run a test for this workflow.'; });
  $('systemPrompt').addEventListener('input', () => status('Unsaved prompt draft. Test it, then save to use it for future reviews.'));
  $('resetPrompt').addEventListener('click', () => { if (config) { $('systemPrompt').value = config.defaults[activeKind]; captureDraft(); status('Default restored in your draft. Save to activate it.'); } });
  $('previewPrompt').addEventListener('click', () => replay(true));
  $('runReplay').addEventListener('click', () => replay(false));
  $('reloadPrompts').addEventListener('click', async () => {
    if (dirty() && !window.confirm('Discard your unsaved prompt edits and reload saved prompts?')) return;
    try {
      config = await api('/api/templates-lab/prompts');
      draft = { classifier: config.settings.classifier ?? config.defaults.classifier, grader: config.settings.grader ?? config.defaults.grader };
      $('systemPrompt').value = draft[activeKind]; status('Saved prompts reloaded.');
    } catch (error) { status(error.message, true); }
  });
  $('savePrompts').addEventListener('click', async () => {
    if (!config || !draft) return;
    captureDraft(); const snapshot = { ...draft };
    $('savePrompts').disabled = true;
    try {
      const saved = await api('/api/templates-lab/prompts', { revision: config.revision, settings: snapshot });
      config = { ...config, ...saved };
      status('Prompts saved. Future reviews use these instructions.');
    } catch (error) { status(error.message, true); }
    finally { $('savePrompts').disabled = false; }
  });
  window.addEventListener('beforeunload', event => { if (dirty() || window.templatesLab.isDirty()) { event.preventDefault(); event.returnValue = ''; } });
  recent();
})();
