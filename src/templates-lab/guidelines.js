const dialog = document.getElementById('guidelinesDialog');
let loaded;
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function render() {
  const query = document.getElementById('guidelinesSearch').value.toLocaleLowerCase('ru');
  const items = loaded.rules.filter(rule => [rule.title, rule.text, rule.source, rule.slug].join(' ').toLocaleLowerCase('ru').includes(query));
  document.getElementById('guidelinesRules').innerHTML = items.map(rule => `<details class="guideline-rule"><summary>${h(rule.title)}</summary><p class="panel-sub">${h(rule.source)} · ${h(rule.updated)}</p><pre>${h(rule.text)}</pre></details>`).join('') || '<p class="panel-sub">No matching rules.</p>';
}
async function open() {
  dialog.showModal();
  try {
    if (!loaded) { const response = await fetch('/api/templates-lab/guidelines'); if (!response.ok) throw new Error('Could not load guidelines.'); loaded = await response.json(); }
    document.getElementById('guidelinesVersion').textContent = `${loaded.source} · ${loaded.rules.length} rule documents · revision ${loaded.revision}`;
    const policy = loaded.grading;
    document.getElementById('gradingPolicy').innerHTML = `<p>${h(policy.description)}</p><table class="bui-table"><thead><tr><th>Category</th><th>Score 2 eligible from</th><th>Score 3 eligible from</th></tr></thead><tbody>${Object.entries(policy.thresholds).map(([category, value]) => `<tr><td>${h(loaded.categoryLabels[category])}</td><td>${h(value.repeated)} ${value.basis === 'timing' ? 'существенных сдвига' : 'правки'}</td><td>${h(value.systemic)} ${value.basis === 'timing' ? 'крупных сдвига' : 'первичные правки'}</td></tr>`).join('')}</tbody></table>${[policy.ownership, policy.timingDescription, policy.micro, policy.evidence].map(text => `<p>${h(text)}</p>`).join('')}`;
    render();
  } catch (error) { document.getElementById('guidelinesVersion').textContent = error.message; }
}
document.querySelectorAll('[data-open-guidelines]').forEach(button => button.addEventListener('click', open));
document.getElementById('closeGuidelines').addEventListener('click', () => dialog.close());
document.getElementById('guidelinesSearch').addEventListener('input', () => { if (loaded) render(); });
