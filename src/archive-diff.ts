import DiffMatchPatch from 'diff-match-patch';
import type { NormalizedState } from './types';
/** Full archived text grouped by recording, independent of model evidence sampling. */
export function archiveTextDiff(original: NormalizedState, current: NormalizedState) {
  const tracks = [...new Set([...original.annotations, ...current.annotations].map(row => row.processedRecordingId))];
  const text = (state: NormalizedState, track: string) => state.annotations.filter(row => row.processedRecordingId === track)
    .sort((a, b) => a.startTimeInSeconds - b.startTimeInSeconds || a.id.localeCompare(b.id)).map(row => row.content).join('\n');
  const engine = new DiffMatchPatch();
  return tracks.map((track, index) => {
    const parts = engine.diff_main(text(original, track), text(current, track));
    engine.diff_cleanupSemantic(parts);
    return { track, label: 'Track ' + (index + 1), parts };
  });
}
