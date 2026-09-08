import type { CategoryName, EditSeverity } from "./types";

export const GRADING_THRESHOLDS = {
  'Word Accuracy': { repeated: 2, systemic: 5, basis: 'count' },
  'Timestamp Accuracy': { repeated: 2, systemic: 3, basis: 'timing' },
  'Punctuation & Formatting': { repeated: 2, systemic: 5, basis: 'count' },
  'Tags & Emphasis': { repeated: 2, systemic: 4, basis: 'count' },
  Segmentation: { repeated: 2, systemic: 4, basis: 'count' }
} as const;
export const TIMING_THRESHOLDS = { toleranceMs: 50, materialMs: 250, severeMs: 500 };
export function buildScoreCap(category: CategoryName, atoms: { severity: EditSeverity }[], isMicroEdit: boolean): 1 | 2 | 3 {
  const rule = GRADING_THRESHOLDS[category];
  const repeated = rule.basis === 'timing' ? atoms.filter(atom => atom.severity !== 'minor').length : atoms.length;
  const systemic = rule.basis === 'timing' ? atoms.filter(atom => atom.severity === 'severe').length : atoms.length;
  let cap: 1 | 2 | 3 = systemic >= rule.systemic ? 3 : repeated >= rule.repeated ? 2 : 1;
  if (isMicroEdit && cap === 3) cap = 2;
  return cap;
}
export function gradingPolicy() {
  return {
    thresholds: GRADING_THRESHOLDS, timing: TIMING_THRESHOLDS,
    description: 'Шкала действующего оценщика: 1 — нет существенных или есть единичные замечания; 2 — повторяющиеся ошибки; 3 — систематические ошибки. Числа ниже — технические верхние границы оценки по доказательствам, а не обязательная оценка и не новая официальная шкала из руководства. Модель может выбрать меньшую оценку, если правки единичны или относятся к служебным действиям без штрафа.',
    ownership: 'Одна первичная ошибка — одна категория. Побочные изменения после разбиения, объединения или исправления слов не учитываются повторно. Удаление комментария L1 «{Возможно, ...}» само по себе не штрафуется.',
    timingDescription: 'Сдвиги до 50 мс включительно не учитываются. Сдвиги больше 50 и меньше 250 мс — малые; от 250 мс — существенные; от 500 мс — крупные. Таймкоды L2 считаются эталонными. Повторная проверка аудио не требуется. В категории таймкодов оценка 2 доступна с двух существенных сдвигов, 3 — с трёх крупных.',
    micro: 'Малая правка: изменено менее 10% устойчиво сопоставленных сегментов, итоговое число сегментов изменилось не более чем на один, всего не более двух первичных правок и нет крупного сдвига таймкода. При таком объёме оценка 3 недоступна.',
    evidence: 'Эталон — исправленная версия L2. Изменения тегов, слов и таймкодов объясняются по актуальным правилам без повторной проверки записи. Не создавай замечаний в неизменённых местах и не штрафуй служебные комментарии L1.'
  };
}
