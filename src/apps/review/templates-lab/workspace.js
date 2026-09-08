(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dialog = $('reviewWorkspace');
  const templateHome = $('templateWorkbench').parentNode;
  const kinds = ['classifier', 'grader'];
  const stageStorageKey = 'babel-review-lab.prompt-stage.v1';
  const workflowNames = { classifier: 'Review Helper', grader: 'Review Grader' };
  const eventNames = { review_generate: 'Feedback generated', review_graded: 'Grades generated', review_applied: 'Review applied', review_submitted: 'Review submitted' };
  const eventName = value => eventNames[value] || String(value || 'Review').replaceAll('_', ' ');
  let task = null, view = 'native', config = null, draft = null, staged = null, loadId = 0;
  let previewId = 0, previewTimer, publishing = false, reloading = false;
  const results = new Map(), runs = new Map();
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
      const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('Review Helper did not respond. Reload the extension and the Lab, then check your OpenRouter key in Settings.')); }, operation === 'ping' ? 1800 : 185000);
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
  const samePrompts = (left, right) => !!left && !!right && kinds.every(kind => left[kind] === right[kind]);
  const publishedPrompts = () => config && Object.fromEntries(kinds.map(kind => [kind, config.settings[kind] ?? config.defaults[kind]]));
  function dirty() { captureDraft(); return !!draft && !samePrompts(draft, staged?.settings || publishedPrompts()); }
  function validPrompts(settings) { return settings && kinds.every(kind => typeof settings[kind] === 'string' && settings[kind].trim() && settings[kind].length <= 40000); }
  function restoreStage() {
    try {
      const saved = JSON.parse(localStorage.getItem(stageStorageKey) || 'null');
      if (saved?.version === 1 && typeof saved.baseRevision === 'string' && validPrompts(saved.settings)) staged = saved;
    } catch (_) { /* Private browsing and unavailable storage still allow temporary edits. */ }
  }
  function updatePromptControls() {
    const temporary = dirty(), published = publishedPrompts();
    const conflict = !!staged && !!config && staged.baseRevision !== config.revision && !samePrompts(staged.settings, published);
    const ready = !!task && !!draft && !!config;
    $('systemPrompt').disabled = $('promptKind').disabled = !ready || reloading;
    $('resetPrompt').disabled = $('reloadPrompts').disabled = !ready || publishing || reloading;
    $('reloadPrompts').textContent = reloading ? 'Reloading…' : 'Reload published';
    $('previewPrompt').disabled = !ready || reloading;
    $('runReplay').disabled = !ready || reloading || runs.has(resultKey());
    $('runReplay').textContent = runs.has(resultKey()) ? 'Generating…' : 'Run tuned version';
    if ($('stagePrompts')) $('stagePrompts').disabled = !ready || !temporary || conflict || publishing || reloading;
    $('savePrompts').disabled = !ready || !staged || temporary || samePrompts(staged.settings, published) || conflict || publishing || reloading;
    if ($('promptStageState')) {
      $('promptStageState').textContent = conflict ? 'Published prompts changed. Reload before staging.' : temporary ? 'Temporary edits · Stage to keep locally' : staged && !samePrompts(staged.settings, published) ? 'Staged locally · Ready to publish' : 'Published · Active for both extensions';
      $('promptStageState').dataset.state = conflict ? 'conflict' : temporary ? 'draft' : staged && !samePrompts(staged.settings, published) ? 'staged' : 'published';
    }
  }
  const resultKey = (historyId = task?.historyId, kind = activeKind) => `${historyId}:${kind}`;
  function replayInput() {
    captureDraft();
    return { historyId: task.historyId, kind: activeKind, systemPrompt: draft[activeKind], categories: window.templatesLab.getDraft() };
  }
  function inputSignature(input) { return JSON.stringify([input.historyId, input.kind, input.systemPrompt, input.kind === 'classifier' ? input.categories : null]); }
  function currentSignature() { return task && draft ? inputSignature(replayInput()) : null; }
  function resultHtml(result) {
    const entries = result?.grades || result?.feedback || result?.aiReview?.feedback;
    if (!Array.isArray(entries)) return `<pre>${h(JSON.stringify(result || 'No saved model result.', null, 2))}</pre>`;
    if (!entries.length) return '<p class="empty-state">No issues found in this response.</p>';
    return entries.map(item => `<article class="grade-result"><strong>${h(item.category)}</strong>${Number.isFinite(item.score) ? `<span class="score">${h(item.score)} / 3</span>` : ''}<p>${h(item.note)}</p>${item.evidence ? `<details><summary>Evidence · ${h(item.evidence.count ?? 0)}</summary><pre>${h(JSON.stringify(item.evidence, null, 2))}</pre></details>` : ''}</article>`).join('');
  }
  function taskCards(items, pinned) {
    return items.map((item, index) => '<article class="task-card"><button type="button" class="recent-task secondary" data-history="' + h(item.historyId) + '"><span class="task-order">' + (pinned ? '◆' : String(index + 1).padStart(2, '0')) + '</span><span class="task-main"><strong>' + h(item.reviewActionId) + '</strong><span class="task-detail">' + h(item.originalSegments) + ' → ' + h(item.currentSegments) + ' segments · ' + h(eventName(item.eventType)) + '</span></span><span class="task-date">' + h(new Date(item.loggedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</span><span class="task-open" aria-hidden="true">Open ↗</span></button><button type="button" class="secondary task-pin" data-pin="' + (pinned ? 'false' : 'true') + '" data-pin-history="' + h(item.historyId) + '" data-action="' + h(item.reviewActionId) + '" aria-label="' + (pinned ? 'Unpin task ' : 'Pin task ') + h(item.reviewActionId) + '">' + (pinned ? 'Unpin' : 'Pin') + '</button></article>').join('');
  }
  async function recent() {
    try {
      const { items, pinned = [] } = await api('/api/templates-lab/recent');
      $('recentTasks').innerHTML = items.length ? taskCards(items, false) : '<p>No unpinned checked tasks are available.</p>';
      $('pinnedTasks').innerHTML = taskCards(pinned, true);
      $('pinnedSection').hidden = !pinned.length;
      if ($('recentCount')) $('recentCount').textContent = String(items.length);
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
    captureDraft();
    const epoch = ++loadId;
    task = null; view = 'native'; ++previewId; clearTimeout(previewTimer);
    templateHome.append($('templateWorkbench'));
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('workspace-open');
    window.labLayout?.closeReview();
    $('workspaceTitle').textContent = 'Opening task…';
    $('workspaceMeta').textContent = '';
    $('nativeArchive').hidden = $('overlayTemplates').hidden = true;
    $('archiveContent').hidden = false;
    $('archivePane').classList.remove('native-pane');
    $('babelArchiveFrame').src = 'about:blank'; delete $('babelArchiveFrame').dataset.history;
    $('archiveContent').textContent = 'Loading archived task…';
    $('savedResult').textContent = $('replayResult').textContent = $('promptPreviewText').textContent = '';
    $('promptPreview').removeAttribute('aria-busy');
    updatePromptControls();
    try {
      const [detail, settings] = await Promise.all([api(`/api/review-history/${encodeURIComponent(historyId)}`), config ? Promise.resolve(config) : api('/api/templates-lab/prompts')]);
      if (epoch !== loadId || !dialog.open) return;
      task = detail; config = settings;
      draft ||= { ...(staged?.settings || publishedPrompts()) };
      $('systemPrompt').value = draft[activeKind];
      $('workspaceTitle').textContent = detail.reviewActionId;
      $('workspaceMeta').textContent = `${new Date(detail.loggedAt).toLocaleString()} · ${eventName(detail.eventType)}`;
      $('labModel').textContent = settings.model;
      status(staged && !samePrompts(staged.settings, publishedPrompts()) ? 'Your locally staged prompts are ready to iterate.' : 'Edit either extension’s prompt, test it, then stage your changes.');
      updatePromptControls(); renderSavedResult(); renderReplayResult(); renderArchive();
      window.labLayout?.onTaskOpen();
      schedulePreview(0);
    } catch (error) {
      if (epoch !== loadId || !dialog.open) return;
      task = null;
      $('workspaceTitle').textContent = 'Task unavailable';
      $('nativeArchive').hidden = true; $('archiveContent').hidden = false;
      $('archiveContent').textContent = `Could not open task: ${error.message}`;
      updatePromptControls();
    }
  }
  function close() {
    window.labLayout?.saveLayout();
    ++loadId; ++previewId; clearTimeout(previewTimer); captureDraft(); task = null;
    templateHome.append($('templateWorkbench'));
    $('babelArchiveFrame').src = 'about:blank'; delete $('babelArchiveFrame').dataset.history;
    dialog.close(); document.body.classList.remove('workspace-open');
    window.labLayout?.onTaskClose();
  }
  function renderSavedResult() {
    if (!task) return;
    const savedKind = task.eventType === 'review_graded' || task.aiReview?.grades ? 'grader' : 'classifier';
    $('savedResult').innerHTML = !task.aiReview ? '<p class="empty-state">No generated response was saved with this task.</p>' : savedKind !== activeKind ? `<p class="empty-state">This snapshot contains a ${h(workflowNames[savedKind])} response. No ${h(workflowNames[activeKind])} response was saved.</p>` : `<p class="panel-sub">${h(workflowNames[savedKind])} · Captured with this task</p>` + resultHtml(task.aiReview);
  }
  function renderReplayResult() {
    if (!task || !draft) return;
    const result = results.get(resultKey());
    if (!result || result.signature !== currentSignature()) {
      $('replayResult').innerHTML = `<div class="empty-state"><strong>${runs.has(resultKey()) ? 'Generating a tuned response…' : result ? 'Your draft has changed' : 'Your next iteration starts here'}</strong><p>${runs.has(resultKey()) ? 'You can keep editing while the model works.' : result ? 'Run the tuned version to see a response for your current prompt and templates.' : 'Run the tuned version to compare its response with the original.'}</p></div>`;
      return;
    }
    $('replayResult').innerHTML = `<p class="panel-sub">${h(workflowNames[activeKind])} · ${h(result.model)} · ${h(result.createdAt)}</p>` + resultHtml(result.response);
  }
  function schedulePreview(delay = 280) {
    ++previewId; clearTimeout(previewTimer);
    if (!task || !draft || !dialog.open) return;
    $('promptPreviewText').textContent = 'Composing current task context…';
    $('promptPreview').setAttribute('aria-busy', 'true');
    previewTimer = setTimeout(preview, delay);
  }
  async function preview() {
    if (!task || !draft || !dialog.open) return;
    const epoch = ++previewId, input = replayInput(), signature = inputSignature(input);
    $('promptPreview').open = true;
    if (!input.systemPrompt.trim() || input.systemPrompt.length > 40000) {
      $('promptPreviewText').textContent = 'Enter a prompt between 1 and 40,000 characters to compose the context.';
      $('promptPreview').removeAttribute('aria-busy'); return;
    }
    if (input.kind === 'classifier' && input.categories.length !== 5) {
      $('promptPreviewText').textContent = 'Waiting for the template library to load…';
      $('promptPreview').removeAttribute('aria-busy'); return;
    }
    try {
      const result = await api('/api/templates-lab/replay', { ...input, previewOnly: true });
      if (epoch !== previewId || !dialog.open || signature !== currentSignature()) return;
      $('promptPreviewText').textContent = `SYSTEM · MODEL PROMPT\n${result.prompts.systemPrompt}\n\nUSER · TASK INSTRUCTIONS & CONTEXT\n${result.prompts.userPrompt}`;
    } catch (error) {
      if (epoch === previewId && dialog.open && signature === currentSignature()) $('promptPreviewText').textContent = 'Could not compose context: ' + error.message;
    } finally { if (epoch === previewId) $('promptPreview').removeAttribute('aria-busy'); }
  }
  async function replay() {
    if (!task || !draft || reloading || runs.has(resultKey())) return;
    const input = replayInput(), signature = inputSignature(input), key = resultKey(), epoch = loadId;
    if (!input.systemPrompt.trim() || input.systemPrompt.length > 40000) { status('Enter a prompt between 1 and 40,000 characters before running.', true); return; }
    runs.set(key, signature); updatePromptControls(); renderReplayResult();
    status('Generating with your current prompt and task context…');
    try {
      const response = await api('/api/templates-lab/replay', { ...input, previewOnly: false });
      results.set(key, { signature, response, model: response.model || config.model, createdAt: new Date().toLocaleTimeString() });
      if (epoch === loadId && dialog.open && resultKey() === key) {
        renderReplayResult();
        status(signature === currentSignature() ? 'Tuned response ready. Stage your prompts to keep this iteration.' : 'Your draft changed during generation. Run again to evaluate the latest edits.');
      }
    } catch (error) {
      if (epoch === loadId && dialog.open && resultKey() === key) status(error.message, true);
    } finally {
      runs.delete(key);
      updatePromptControls();
      if (dialog.open && resultKey() === key) renderReplayResult();
    }
  }
  $('recentTasks').addEventListener('click', taskClick);
  $('pinnedTasks').addEventListener('click', taskClick);
  $('reloadRecent').addEventListener('click', recent);
  $('overlaySaveTemplates').addEventListener('click', () => ($('stageDraftBtn') || $('saveDraftBtn')).click());
  $('overlayDiscardTemplates').addEventListener('click', () => $('discardDraftBtn').click());
  $('closeWorkspace').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { view = button.dataset.view; renderArchive(); }));
  $('promptKind').addEventListener('change', () => {
    if (reloading) { $('promptKind').value = activeKind; return; }
    captureDraft(); activeKind = $('promptKind').value;
    if (draft) $('systemPrompt').value = draft[activeKind];
    updatePromptControls(); renderSavedResult(); renderReplayResult(); schedulePreview(0);
    status(runs.has(resultKey()) ? 'A tuned response is generating for this workflow.' : `Editing ${workflowNames[activeKind]} instructions.`);
  });
  function promptChanged(message) {
    captureDraft(); updatePromptControls(); renderReplayResult(); schedulePreview();
    status(dirty() ? message : staged && !samePrompts(staged.settings, publishedPrompts()) ? 'Using your staged prompts. Run to compare, or publish when ready.' : 'Using published prompts. Edit to start a new iteration.');
  }
  $('systemPrompt').addEventListener('input', () => promptChanged('Temporary prompt edits. Test freely, then stage to keep them locally.'));
  $('resetPrompt').addEventListener('click', () => {
    if (config && !reloading) { $('systemPrompt').value = config.defaults[activeKind]; promptChanged('Default restored in your temporary draft. Stage when ready.'); }
  });
  $('previewPrompt').addEventListener('click', () => schedulePreview(0));
  $('runReplay').addEventListener('click', replay);
  $('reloadPrompts').addEventListener('click', async () => {
    if (!config || !draft || publishing || reloading) return;
    if ((dirty() || staged && !samePrompts(staged.settings, publishedPrompts())) && !window.confirm('Discard temporary and locally staged prompt edits for both extensions and reload the published prompts?')) return;
    reloading = true; updatePromptControls(); status('Reloading published prompts for both extensions…');
    try {
      const settings = await api('/api/templates-lab/prompts');
      localStorage.removeItem(stageStorageKey);
      config = settings; staged = null; draft = { ...publishedPrompts() };
      $('systemPrompt').value = draft[activeKind]; $('labModel').textContent = config.model;
      renderReplayResult(); schedulePreview(0); status('Published prompts reloaded for both extensions.');
    } catch (error) { status(error.message, true); }
    finally { reloading = false; updatePromptControls(); }
  });
  $('stagePrompts')?.addEventListener('click', () => {
    if (!config || !draft || reloading) return;
    captureDraft();
    if (!validPrompts(draft)) { status('Both prompts must contain between 1 and 40,000 characters before staging.', true); return; }
    const snapshot = { version: 1, baseRevision: config.revision, settings: { ...draft }, savedAt: new Date().toISOString() };
    try {
      localStorage.setItem(stageStorageKey, JSON.stringify(snapshot));
      staged = snapshot; updatePromptControls(); status('Both prompts staged in this browser. Keep iterating, or publish for everyone.');
    } catch (_) { status('This browser could not save the stage. Your temporary edits remain here; enable site storage and try again.', true); }
  });
  $('savePrompts').addEventListener('click', async () => {
    if (!config || !draft || !staged || publishing || reloading) return;
    if (dirty()) { status('Stage your latest prompt edits before publishing.', true); return; }
    const snapshot = { ...staged.settings }, revision = staged.baseRevision;
    publishing = true; updatePromptControls();
    try {
      const saved = await api('/api/templates-lab/prompts', { revision, settings: snapshot });
      config = { ...config, ...saved };
      staged = { ...staged, baseRevision: config.revision };
      try { localStorage.setItem(stageStorageKey, JSON.stringify(staged)); } catch (_) { /* The shared publish succeeded even if local storage became unavailable. */ }
      status('Prompts published. Both extensions now use these instructions for new reviews.');
    } catch (error) { status(error.message, true); }
    finally { publishing = false; updatePromptControls(); }
  });
  // Template edits are applied by the separate workbench. Its status updates after
  // loading, applying, staging, or discarding a draft; only changed input needs a preview.
  let templateSignature = '';
  new MutationObserver(() => {
    const signature = JSON.stringify(window.templatesLab.getDraft());
    if (signature === templateSignature) return;
    templateSignature = signature;
    if (task && activeKind === 'classifier') { renderReplayResult(); schedulePreview(); }
  }).observe($('status'), { childList: true, characterData: true, subtree: true });
  window.addEventListener('beforeunload', event => { if (dirty() || window.templatesLab.isDirty()) { event.preventDefault(); event.returnValue = ''; } });
  restoreStage();
  updatePromptControls();
  recent();
})();
