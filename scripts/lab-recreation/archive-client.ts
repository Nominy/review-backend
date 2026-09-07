import type { ScenarioState } from './scenario-client';
type Row = { id: string; content: string; processedRecordingId: string; startTimeInSeconds: number; endTimeInSeconds: number; [key: string]: unknown };
type Snapshot = { actionId: string; actionLevel: number; annotations: Row[]; recordings: Record<string, unknown>[]; lintErrors: unknown[]; [key: string]: unknown };
type Archive = { original: Snapshot; current: Snapshot; loggedAt: string; babelDiff?: { diffPayload?: unknown }; aiReview?: { feedback?: { category: string; score: number; note: string }[]; grades?: { category: string; score: number; note: string }[] }; textDiff: { track: string; parts: [number, string][] }[] };
const historyId = new URLSearchParams(location.search).get('labHistoryId');
const viewer = '00000000-0000-4000-8000-000000000001';
const projectId = '00000000-0000-4000-8000-000000000002';
let archive: Archive;
let scenario: ScenarioState;
let actions: Record<string, any>[] = [];
const rubric = [['wordAccuracy', 'Word Accuracy', 'tx-word-accuracy'], ['timestampAccuracy', 'Timestamp Accuracy', 'tx-timestamp-accuracy'], ['punctuationFormatting', 'Punctuation & Formatting', 'tx-punctuation-formatting'], ['tagsEmphasis', 'Tags & Emphasis', 'tx-tags-emphasis'], ['segmentation', 'Segmentation', 'tx-segmentation']];
function action(id: unknown) { const found = actions.find(item => item.actionId === id); if (!found) throw new Error('This action is not part of the archived task.'); return found; }
function fallbackDiff(reference: Record<string, any>, current: Record<string, any>) {
  const segment = (row: Row) => ({ annotationId: row.id, text: row.content, content: row.content, startTime: row.startTimeInSeconds, endTime: row.endTimeInSeconds, startTimeInSeconds: row.startTimeInSeconds, endTimeInSeconds: row.endTimeInSeconds, wordRange: [0, row.content.trim().split(/\s+/).length] });
  return { referenceReviewActionId: reference.actionId, currentReviewActionId: current.actionId, referenceLevel: reference.actionLevel, currentLevel: current.actionLevel,
    referenceAnnotations: reference.annotations, currentAnnotations: current.annotations,
    speakerDiffs: archive.textDiff.map((track, index) => {
      const before = reference.annotations.filter((row: Row) => row.processedRecordingId === track.track);
      const after = current.annotations.filter((row: Row) => row.processedRecordingId === track.track);
      const wordDiffs = track.parts.map(([op, value]) => ({ value, status: op < 0 ? 'removed' : op > 0 ? 'added' : 'unchanged' }));
      return { speaker: index + 1, processedRecordingId: track.track, wordDiffs, segmentMappings: [{ relationship: 'modified', referenceText: before.map((row: Row) => row.content).join(' '), hypothesisText: after.map((row: Row) => row.content).join(' '), segmentsA: before.map(segment), segmentsB: after.map(segment), wordDiffs }] };
    }), timestampMetrics: { segments: { details: [] } } };
}
function playableUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ? url.href : ''; } catch { return ''; }
}
export const archiveTransport = {
  async load(signal?: AbortSignal): Promise<ScenarioState> {
    if (!historyId || !/^(?:\d+|pinned:[a-zA-Z0-9-]+)$/.test(historyId)) throw new Error('An archived history ID is required.');
    const response = await fetch('/api/review-history/' + encodeURIComponent(historyId), { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error('Could not load archived task (' + response.status + ').');
    archive = await response.json();
    const tracks = [...new Set([...archive.original.annotations, ...archive.current.annotations].map(row => row.processedRecordingId))];
    const duration = Math.max(1, ...archive.current.annotations.map(row => row.endTimeInSeconds));
    actions = [archive.original, archive.current].map(snapshot => ({ ...snapshot, reviewActionId: snapshot.actionId, actionWorkerId: viewer, success: true, isWorkerResumingClaim: false,
      processedTranscriptionId: snapshot.actionId, transcriptionChunkId: snapshot.actionId, recordingChunkId: snapshot.actionId,
      annotations: snapshot.annotations.map(row => ({ ...row, type: 'transcription', reviewActionId: snapshot.actionId, speaker: tracks.indexOf(row.processedRecordingId) + 1, speakerId: row.processedRecordingId })),
      transcriptionChunkProcessedRecordings: tracks.map((id, index) => ({ id, processedRecordingId: id, chunkedProcessedRecordingId: id, transcriptionChunkId: snapshot.actionId, speaker: index + 1, startTimeInSeconds: 0, endTimeInSeconds: duration, label: 'Track ' + (index + 1) })), processedRecordingUriMap: Object.fromEntries(tracks.map(id => [id, 'archive-unavailable:' + id]))
    }));
    scenario = { scenario: 'archive', project: { projectId, category: 'transcription', projectName: 'Archived transcript', name: 'Archived transcript' }, worker: { id: viewer, name: 'Archive viewer' },
      action: actions[1] as ScenarioState['action'], referenceAction: actions[0], projectId, readOnly: true, route: location.pathname + location.search,
      page: { path: location.pathname, search: location.search, showTaskLookupModal: false }, pageProps: { showTaskLookupModal: false }, audio: { transport: 'fetch' } };
    const audioRecordings = tracks.flatMap(id => {
      const recording = [...archive.current.recordings, ...archive.original.recordings].find(recording => recording.processedRecordingId === id && playableUrl(recording.processedRecordingUrl));
      return recording ? [{ ...recording, id: recording.id || id, processedRecordingId: id, chunkedProcessedRecordingId: recording.chunkedProcessedRecordingId || id, processedRecordingUrl: playableUrl(recording.processedRecordingUrl), label: 'Track ' + (tracks.indexOf(id) + 1) }] : [];
    });
    document.documentElement.dataset.archiveAudio = audioRecordings.length ? 'available' : 'missing';
    scenario.archiveWorkbenchProps = { reviewActionId: archive.current.actionId, reviewActionLevel: archive.current.actionLevel, transcriptionChunkProcessedRecordings: audioRecordings, annotations: actions[1].annotations, linterErrors: archive.current.lintErrors, mode: 'transcription', projectId, settingsProjectId: projectId, projectCategory: 'transcription', isAdmin: false, processedTranscriptionId: '', queueId: projectId, readOnly: true, isRTL: false, initialFeedbackOpen: false };
    return scenario;
  },
  async request(procedure: string, input: unknown) {
    const body = (input || {}) as Record<string, any>;
    switch (procedure) {
      case 'worker.getProjectById': return scenario.project;
      case 'worker.getProjects': case 'worker.getProjectsWithAvailability': return [scenario.project];
      case 'transcriptions.getWorkerPermissionsForProject': return [{ reviewQueueId: projectId, level: 2, tag: 'practice' }];
      case 'transcriptions.checkActiveClaimForQueue': return null;
      case 'transcriptions.getReviewActionDataById': return action(body.reviewActionId);
      case 'transcriptions.getAnnotationsByReviewActionId': { const item = action(body.reviewActionId); return { annotations: item.annotations, lintErrors: item.lintErrors }; }
      case 'transcriptions.getReviewActionsForChunk': case 'annotations.getReviewActionsForRecordingChunk':
        return actions.filter(item => item.actionId !== (body.excludeReviewActionId || body.reviewActionId)).map(item => ({ id: item.actionId, reviewActionId: item.actionId, level: item.actionLevel, actionLevel: item.actionLevel, workerId: viewer, createdAt: archive.loggedAt, decision: item.actionDecision }));
      case 'transcriptions.getTranscriptionDiff': {
        const raw = archive.babelDiff?.diffPayload as any;
        const payload = raw?.result?.data?.json ?? raw?.result?.data ?? raw;
        if (payload?.speakerDiffs) return payload;
        return fallbackDiff(action(body.referenceReviewActionId), action(body.currentReviewActionId));
      }
      case 'annotations.getAnnotationDiffOverlay': return { referenceAnnotations: actions[0].annotations, currentAnnotations: actions[1].annotations };
      case 'annotations.getAnnotationMetricsDiff': return { metrics: { referenceCount: actions[0].annotations.length, currentCount: actions[1].annotations.length } };
      case 'application.getAudioPresignedUrls': return Object.fromEntries((body.s3Urls || []).map((source: string) => [source, '']));
      case 'transcriptions.emitReviewActionEvents': return { success: true }; // Viewing events stay inside this iframe.
      case 'transcriptionFeedbackForm.getForm': return { id: 'archive-form', name: 'Saved review', steps: [{ id: 'archive-step', order: 0 }] };
      case 'forms.getFormInputsByStepId': return rubric.flatMap(([key, label]) => [{ id: 'input-' + key, label, type: 'rating', required: true }, { id: 'input-' + key + '-comment', label: label + ' Comment', type: 'textarea', required: true }]);
      case 'transcriptionFeedbackForm.getRubricFlagNames': return rubric.map(item => item[2]);
      case 'transcriptionFeedbackForm.getFeedbackReceived': {
        const grades = archive.aiReview?.grades || archive.aiReview?.feedback || [];
        return { inputResponses: rubric.flatMap(([key, category]) => { const grade = grades.find(item => item.category === category); return grade ? [{ formInputId: 'input-' + key, value: String(grade.score) }, { formInputId: 'input-' + key + '-comment', value: grade.note }] : []; }), updatedAt: archive.loggedAt };
      }
      case 'transcriptions.getForeignTagDictionary': return null;
      case 'tts.getTagNamesByType': return [];
      case 'backgroundNoise.getNoiseEventsForRecordings': return [];
      case 'transcriptions.getStitchedChunkReviewers': return [];
      case 'transcriptions.getChunkConsensus': case 'transcriptions.getAssessmentInfo': case 'transcriptions.getOnboardingAttemptStatus': return null;
      case 'transcriptions.isDegradedTranscriptionChunk': return false;
      case 'transcriptions.getAssessmentAttemptCount': return { attemptCount: 0 };
      default: throw new Error('Archived task is read-only. Operation is unavailable: ' + procedure);
    }
  }
};
