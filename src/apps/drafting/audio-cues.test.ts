import { describe, expect, test } from "bun:test";
import {
  buildAudioCueBatchFfmpegArgs,
  buildAudioCueBatchPlan,
  buildAudioCueTempPaths
} from "./audio-cues";
import type { DraftingTranscriptRowInput } from "./types";

const baseRow: DraftingTranscriptRowInput = {
  rowId: "r1",
  speakerKey: "speaker-1",
  startSeconds: 1,
  endSeconds: 2,
  text: "Привет",
  index: 0
};

describe("audio cue slicing", () => {
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
          ...baseRow,
          startSeconds: 1,
          endSeconds: 2
        },
        outputPath: "row-1.wav"
      },
      {
        row: {
          ...baseRow,
          rowId: "r2",
          startSeconds: 3,
          endSeconds: 4.25
        },
        outputPath: "row-2.wav"
      }
    ]);

    const filterGraph = args[args.indexOf("-filter_complex") + 1];

    expect(filterGraph).toContain("atrim=start=0:duration=3");
    expect(filterGraph).toContain("[out0]");
    expect(filterGraph).not.toContain(",[out0]");
    expect(filterGraph).toContain("atrim=start=2:duration=3.25");
    expect(filterGraph).toContain("[out1]");
    expect(filterGraph).not.toContain(",[out1]");
    expect(args).toContain("row-1.wav");
    expect(args).toContain("row-2.wav");
    expect(args.filter((arg) => arg === "-map")).toHaveLength(2);
  });

  test("clamps tail row slices to the uploaded track duration", () => {
    const plan = buildAudioCueBatchPlan(
      [
        {
          row: {
            ...baseRow,
            rowId: "tail",
            startSeconds: 149.47,
            endSeconds: 161.82
          },
          outputPath: "tail.wav"
        },
        {
          row: {
            ...baseRow,
            rowId: "past-end",
            startSeconds: 151,
            endSeconds: 162
          },
          outputPath: "past-end.wav"
        }
      ],
      150
    );
    const args = buildAudioCueBatchFfmpegArgs("input.wav", plan.slices);
    const filterGraph = args[args.indexOf("-filter_complex") + 1];

    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0]?.row.rowId).toBe("tail");
    expect(plan.skippedRows.map((row) => row.rowId)).toEqual(["past-end"]);
    expect(filterGraph).toContain("atrim=start=148.47:duration=1.53");
    expect(args).toContain("tail.wav");
    expect(args).not.toContain("past-end.wav");
  });
});
