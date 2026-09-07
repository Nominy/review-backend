import { CATEGORIES } from "./rules";
import type { PromptPacket } from "./types";
import { guidelinesPrompt, REVIEW_DATA_BOUNDARY, REVIEW_INTERPRETATION } from '../../../guidelines';
import { gradingPolicy } from '../policy';

export function buildPrompts(promptPacket: PromptPacket) {
  const schema = { feedback: CATEGORIES.map(category => ({ category, score: 1, note: "Краткое пояснение по-русски" })) };
  const systemPrompt = [
    "Ты — проверяющий L2 в Babel Audio. Оцениваешь работу L1 по изменениям между исходной версией L1 и эталонной исправленной версией L2. Аудио для этой задачи не требуется.",
    REVIEW_INTERPRETATION,
    "Шкала: 1 — нет существенных или есть единичные замечания; 2 — повторяющиеся ошибки; 3 — систематические ошибки. Верхние границы scoreCaps обязательны. Они не предписывают оценку: служебные действия без штрафа и побочные эффекты не повышают её.",
    "Без существенных подтверждённых ошибок оставь 1. Не используй количество токенов в служебном теге как число ошибок. Не дублируй замечание в разных категориях.",
    "Для каждой категории дай короткое практическое пояснение на русском, до 500 символов. При оценке 1 пиши спокойно и кратко; при 2–3 конкретно объясни повторяющийся недостаток. Не выдумывай примеры и не заявляй о личном прослушивании записи.",
    REVIEW_DATA_BOUNDARY,
    "Верни только строгий JSON. Ровно пять разных категорий с неизменными техническими названиями. Схема:", JSON.stringify(schema)
  ].join('\n');
  const userPrompt = [
    "Проверь доказательства по категориям. Для каждой правки установи: какое актуальное правило объясняет исправление L2, является ли ошибка первичной и достаточно ли независимых исправлений для повышения оценки. Не оспаривай эталон L2.",
    "Политика оценивания:", JSON.stringify(gradingPolicy(), null, 2),
    guidelinesPrompt(),
    "Пакет доказательств (технические ключи сохранены):",
    JSON.stringify({ editFootprint: promptPacket.editFootprint, ownershipSummary: promptPacket.ownershipSummary, scoreCaps: promptPacket.scoreCaps, categoryEvidence: promptPacket.categoryEvidence }, null, 2),
    REVIEW_DATA_BOUNDARY
  ].join('\n');
  return { systemPrompt, userPrompt, preview: 'СИСТЕМНЫЕ ИНСТРУКЦИИ:\n' + systemPrompt + '\n\nДАННЫЕ ПРОВЕРКИ:\n' + userPrompt };
}
