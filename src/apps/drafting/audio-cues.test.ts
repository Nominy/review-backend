import { describe, expect, test } from "bun:test";
import { buildAudioCueBatchFfmpegArgs, buildAudioCueTempPaths, generateAudioCueDraft } from "./audio-cues";
import type { AudioCueDraftRequest } from "./types";

const baseRequest: AudioCueDraftRequest = {
  projectPreset: "ru-gold-2sp-v1",
  jobId: "job-audio",
  openRouterApiKey: "sk-or-test",
  model: "google/gemini-3-flash-preview",
  rows: [
    {
      rowId: "r1",
      speakerKey: "speaker-1",
      startSeconds: 1,
      endSeconds: 2,
      text: "Привет",
      index: 0
    }
  ],
  audioTracks: [
    {
      trackId: "track-1",
      fileName: "track-1.webm",
      mimeType: "audio/webm",
      bytes: new Uint8Array([1, 2, 3])
    },
    {
      trackId: "track-2",
      fileName: "track-2.webm",
      mimeType: "audio/webm",
      bytes: new Uint8Array([4, 5, 6])
    }
  ]
};

describe("generateAudioCueDraft", () => {
  test("uses distinct ffmpeg input and output temp paths for wav uploads", () => {
    const paths = buildAudioCueTempPaths("fixed-id", "speaker-1.wav");

    expect(paths.inputPath).not.toBe(paths.outputPath);
    expect(paths.inputPath).toEndWith(".input.wav");
    expect(paths.outputPath).toEndWith(".output.wav");
  });

  test("builds one ffmpeg command that trims multiple row clips from one input", () => {
    const args = buildAudioCueBatchFfmpegArgs("input.wav", [
      {
        row: {
          ...baseRequest.rows[0]!,
          startSeconds: 1,
          endSeconds: 2
        },
        outputPath: "row-1.wav"
      },
      {
        row: {
          ...baseRequest.rows[0]!,
          rowId: "r2",
          startSeconds: 3,
          endSeconds: 4.25
        },
        outputPath: "row-2.wav"
      }
    ]);

    const filterGraph = args[args.indexOf("-filter_complex") + 1];

    expect(filterGraph).toContain("atrim=start=0.8:duration=1.4");
    expect(filterGraph).toContain("[out0]");
    expect(filterGraph).not.toContain(",[out0]");
    expect(filterGraph).toContain("atrim=start=2.8:duration=1.65");
    expect(filterGraph).toContain("[out1]");
    expect(filterGraph).not.toContain(",[out1]");
    expect(args).toContain("row-1.wav");
    expect(args).toContain("row-2.wav");
    expect(args.filter((arg) => arg === "-map")).toHaveLength(2);
  });

  test("passes row-length slices from every uploaded track into the audio rewrite request", async () => {
    const seenSlices: string[] = [];

    const response = await generateAudioCueDraft(baseRequest, {
      validateAudioModel: async () => {},
      sliceAudio: async ({ track, row }) => {
        seenSlices.push(`${track.trackId}:${row.startSeconds}-${row.endSeconds}`);
        return {
          trackId: track.trackId,
          format: "wav",
          base64: Buffer.from(`${track.trackId}:${row.rowId}`).toString("base64")
        };
      },
      rewriteRowWithAudio: async ({ audioClips }) => {
        expect(audioClips.map((clip) => clip.trackId)).toEqual(["track-1", "track-2"]);
        return "[смех] Привет";
      }
    });

    expect(seenSlices).toEqual(["track-1:1-2", "track-2:1-2"]);
    expect(response.draftRows[0]).toEqual({
      rowId: "r1",
      rewrittenText: "[смех] Привет",
      status: "rewritten",
      warnings: ["audio_cues_added"]
    });
  });

  test("falls back to the original row when audio cue output changes transcript words", async () => {
    const response = await generateAudioCueDraft(baseRequest, {
      validateAudioModel: async () => {},
      sliceAudio: async ({ track }) => ({ trackId: track.trackId, format: "wav", base64: "AAAA" }),
      rewriteRowWithAudio: async () => "[смех] Пока"
    });

    expect(response.draftRows[0]).toEqual({
      rowId: "r1",
      rewrittenText: "Привет",
      status: "failed",
      warnings: ["text_drift"]
    });
  });

  test("uses only the audio track mapped to the row speaker lane", async () => {
    const seenSlices: string[] = [];
    const seenClips: string[][] = [];

    const response = await generateAudioCueDraft(
      {
        ...baseRequest,
        rows: [
          {
            ...baseRequest.rows[0]!,
            speakerKey: "Speaker 2"
          }
        ],
        audioTracks: [
          {
            ...baseRequest.audioTracks[0]!,
            speakerKey: "recording-a",
            trackLabel: "Speaker 1"
          },
          {
            ...baseRequest.audioTracks[1]!,
            speakerKey: "recording-b",
            trackLabel: "Speaker 2"
          }
        ]
      },
      {
        validateAudioModel: async () => {},
        sliceAudio: async ({ track, row }) => {
          seenSlices.push(`${track.trackId}:${track.speakerKey}:${track.trackLabel}:${row.speakerKey}`);
          return {
            trackId: track.trackId,
            speakerKey: track.speakerKey,
            trackLabel: track.trackLabel,
            format: "wav",
            base64: Buffer.from(`${track.trackId}:${row.rowId}`).toString("base64")
          };
        },
        rewriteRowWithAudio: async ({ audioClips, currentRow }) => {
          seenClips.push(audioClips.map((clip) => `${clip.trackId}:${clip.speakerKey}:${clip.trackLabel}`));
          return currentRow.text;
        }
      }
    );

    expect(seenSlices).toEqual(["track-2:recording-b:Speaker 2:Speaker 2"]);
    expect(seenClips).toEqual([["track-2:recording-b:Speaker 2"]]);
    expect(response.draftRows[0]?.status).toBe("unchanged");
  });

  test("rejects the request before slicing when the selected model has no audio input", async () => {
    await expect(
      generateAudioCueDraft(baseRequest, {
        validateAudioModel: async (model) => {
          throw new Error(`OpenRouter model does not support audio input: ${model}`);
        },
        sliceAudio: async ({ track }) => ({ trackId: track.trackId, format: "wav", base64: "AAAA" }),
        rewriteRowWithAudio: async () => "[смех] Привет"
      })
    ).rejects.toThrow("OpenRouter model does not support audio input: google/gemini-3-flash-preview");
  });
});
