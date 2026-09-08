import { applyComponent, themeRoot } from '@nominy/babel-extension-frontend/components';
import './guidelines.js';
themeRoot(document.body, 'orange');
const mappings = [
  ['.hero,.panel,.status-panel,.diff-change,.archive-timeline,.transcript-table', 'panel'],
  ['.meta-card,.list-item,.variant-item,.pending-item,.grade-result', 'card'],
  ['h1', 'heading'], ['h2,h3', 'title'], ['label:not(.toggle):not(.compact-toggle)', 'field'],
  ['label > span,.meta-label,.eyebrow', 'label'], ['.toggle,.compact-toggle', 'toggle'],
  ['input:not([type=checkbox])', 'input'], ['input[type=checkbox]', 'checkbox'],
  ['select', 'select'], ['textarea', 'textarea'], ['summary', 'summary'],
  ['.sub,.panel-sub,.archive-notice,.list-item-meta,.list-item-desc,.pending-item-meta,.pending-item-desc,.pending-item-reason', 'hint'],
  ['.pill,.score,.change-type', 'badge'], ['.empty-state', 'empty'],
  ['#promptStatus,.status', 'status'], ['.diff-pair', 'diff'], ['.diff-pair > div', 'diff-pane'],
];
function decorate(root) {
  const each = (selector, callback) => {
    if (root.matches?.(selector)) callback(root);
    root.querySelectorAll(selector).forEach(callback);
  };
  each('button', element => applyComponent(element, 'button', { variant: element.classList.contains('danger') ? 'danger' : element.matches('.secondary,.recent-task,.task-pin,[data-view]') ? 'secondary' : 'primary' }));
  for (const [selector, component] of mappings) each(selector, element => applyComponent(element, component));
}
decorate(document.body);
new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) decorate(node);
}).observe(document.body, { childList: true, subtree: true });
