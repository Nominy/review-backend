import { afterEach, describe, expect, test } from "bun:test";
import { generateDraft } from "./service";
import type { AudioCueAudioTrackInput, GenerateDraftRequest, RowRewriteContext } from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const baseRequest: GenerateDraftRequest = {
  projectPreset: "ru-gold-2sp-v1",
  jobId: "job-1",
  openRouterApiKey: "sk-or-test",
  rows: [
    {
      rowId: "r1",
      speakerKey: "spk-1",
      startSeconds: 1,
      endSeconds: 2,
      text: "privet",
      index: 0
    },
    {
      rowId: "r2",
      speakerKey: "spk-2",
      startSeconds: 2,
      endSeconds: 3,
      text: "da",
      index: 1
    }
  ]
};

describe("generateDraft", () => {
  test("keeps row count and row ids aligned with the input contract", async () => {
    const response = await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) => context.currentRow.text.toUpperCase()
    });

    expect(response.draftRows).toHaveLength(2);
    expect(response.draftRows.map((row) => row.rowId)).toEqual(["r1", "r2"]);
    expect(response.summary.totalRows).toBe(2);
  });

  test("falls back only for the failing row and continues the transcript", async () => {
    const response = await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) =>
        context.currentRow.rowId === "r1" ? "" : `${context.currentRow.text}.`
    });

    expect(response.draftRows[0]).toEqual({
      rowId: "r1",
      rewrittenText: "privet",
      status: "failed",
      warnings: ["empty_output"]
    });
    expect(response.draftRows[1].rowId).toBe("r2");
    expect(response.summary.failedRows).toBe(1);
  });

  test("marks rewrite exceptions as row-local failures", async () => {
    const response = await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) => {
        if (context.currentRow.rowId === "r2") {
          throw new Error("network blip");
        }
        return "Privet.";
      }
    });

    expect(response.draftRows[0].status).toBe("rewritten");
    expect(response.draftRows[1].status).toBe("failed");
    expect(response.draftRows[1].warnings[0]).toBe("rewrite_error");
  });

  test("passes only the current row into the rewrite context", async () => {
    const seenContexts: RowRewriteContext[] = [];

    await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) => {
        seenContexts.push(context);
        return `${context.currentRow.text}.`;
      }
    });

    expect(seenContexts).toHaveLength(2);
    expect(seenContexts[0]).toEqual({
      currentRow: baseRequest.rows[0]
    });
    expect(seenContexts[1]).toEqual({
      currentRow: baseRequest.rows[1]
    });
  });

  test("emits row progress as each row completes", async () => {
    const events: Array<{ rowId: string; completedRows: number; failedRows: number }> = [];

    await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) =>
        context.currentRow.rowId === "r1" ? `${context.currentRow.text}.` : "",
      onRowComplete: async ({ row, completedRows, summary }) => {
        events.push({
          rowId: row.rowId,
          completedRows,
          failedRows: summary.failedRows
        });
      }
    });

    expect(events).toEqual([
      { rowId: "r1", completedRows: 1, failedRows: 0 },
      { rowId: "r2", completedRows: 2, failedRows: 1 }
    ]);
  });

  test("keeps final draft rows in input order even when responses finish out of order", async () => {
    const completionOrder: string[] = [];

    const response = await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) => {
        if (context.currentRow.rowId === "r1") {
          await delay(20);
          return "Privet.";
        }
        await delay(1);
        return "Da.";
      },
      onRowComplete: async ({ row }) => {
        completionOrder.push(row.rowId);
      }
    });

    expect(completionOrder).toEqual(["r2", "r1"]);
    expect(response.draftRows.map((row) => row.rowId)).toEqual(["r1", "r2"]);
    expect(response.draftRows.map((row) => row.rewrittenText)).toEqual(["Privet.", "Da."]);
  });

  test("limits concurrent row work for larger audio drafts", async () => {
    let activeRows = 0;
    let maxActiveRows = 0;
    const rows = Array.from({ length: 5 }, (_, index) => ({
      rowId: `r${index + 1}`,
      speakerKey: "spk-1",
      startSeconds: index,
      endSeconds: index + 1,
      text: `row ${index + 1}`,
      index
    }));

    const response = await generateDraft(
      {
        ...baseRequest,
        rows
      },
      {
        rowConcurrency: 2,
        rewriteRow: async (context: RowRewriteContext) => {
          activeRows += 1;
          maxActiveRows = Math.max(maxActiveRows, activeRows);
          await delay(10);
          activeRows -= 1;
          return `${context.currentRow.text}.`;
        }
      }
    );

    expect(maxActiveRows).toBeLessThanOrEqual(2);
    expect(response.draftRows.map((row) => row.rowId)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  test("runs row rewrites concurrently by default", async () => {
    const previousEnvConcurrency = process.env.DRAFT_ROW_CONCURRENCY;
    delete process.env.DRAFT_ROW_CONCURRENCY;

    let activeRows = 0;
    let maxActiveRows = 0;
    const rows = Array.from({ length: 5 }, (_, index) => ({
      rowId: `r${index + 1}`,
      speakerKey: "spk-1",
      startSeconds: index,
      endSeconds: index + 1,
      text: `row ${index + 1}`,
      index
    }));

    try {
      await generateDraft(
        {
          ...baseRequest,
          rows
        },
        {
          rewriteRow: async (context: RowRewriteContext) => {
            activeRows += 1;
            maxActiveRows = Math.max(maxActiveRows, activeRows);
            await delay(10);
            activeRows -= 1;
            return `${context.currentRow.text}.`;
          }
        }
      );
    } finally {
      if (previousEnvConcurrency === undefined) {
        delete process.env.DRAFT_ROW_CONCURRENCY;
      } else {
        process.env.DRAFT_ROW_CONCURRENCY = previousEnvConcurrency;
      }
    }

    expect(maxActiveRows).toBe(5);
  });

  test("retries a failed row call once before succeeding", async () => {
    const attempts = new Map<string, number>();

    const response = await generateDraft(baseRequest, {
      rewriteRow: async (context: RowRewriteContext) => {
        const currentAttempts = (attempts.get(context.currentRow.rowId) || 0) + 1;
        attempts.set(context.currentRow.rowId, currentAttempts);

        if (context.currentRow.rowId === "r1" && currentAttempts === 1) {
          throw new Error("temporary upstream failure");
        }

        return `${context.currentRow.text}.`;
      }
    });

    expect(attempts.get("r1")).toBe(2);
    expect(attempts.get("r2")).toBe(1);
    expect(response.draftRows[0]).toEqual({
      rowId: "r1",
      rewrittenText: "privet.",
      status: "rewritten",
      warnings: ["length_delta"]
    });
  });

  test("retries an empty model response before validating the row", async () => {
    let chatCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (!target.includes("/api/v1/chat/completions")) {
        throw new Error(`Unexpected fetch ${target}`);
      }

      chatCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: chatCalls === 1 ? "" : "А Spotify и YouTube Music."
              }
            }
          ]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }) as unknown as typeof fetch;

    const response = await generateDraft(
      {
        ...baseRequest,
        rows: [
          {
            rowId: "r1",
            speakerKey: "spk-1",
            startSeconds: 1,
            endSeconds: 2,
            text: "А Spotify и YouTube Music",
            index: 0
          }
        ],
        model: "google/gemini-3-flash-preview"
      },
      {
        testMode: false,
        validateModel: async () => {}
      }
    );

    expect(chatCalls).toBe(2);
    expect(response.draftRows[0]).toEqual({
      rowId: "r1",
      rewrittenText: "А Spotify и YouTube Music.",
      status: "rewritten",
      warnings: ["length_delta"]
    });
  });

  test("validates the selected OpenRouter model before rewriting rows", async () => {
    const seenModels: string[] = [];

    await expect(
      generateDraft(
        {
          ...baseRequest,
          model: "missing/model"
        },
        {
          testMode: false,
          apiKey: "sk-or-test",
          validateModel: async (model) => {
            seenModels.push(model);
            throw new Error(`OpenRouter model does not exist: ${model}`);
          }
        }
      )
    ).rejects.toThrow("OpenRouter model does not exist: missing/model");

    expect(seenModels).toEqual(["missing/model"]);
  });

  test("validates the configured backend model when the request leaves model blank", async () => {
    const seenModels: string[] = [];

    await expect(
      generateDraft(
        {
          ...baseRequest,
          model: "   "
        },
        {
          testMode: false,
          apiKey: "sk-or-test",
          model: "openai/default-model",
          validateModel: async (model) => {
            seenModels.push(model);
            throw new Error(`checked ${model}`);
          }
        }
      )
    ).rejects.toThrow("checked openai/default-model");

    expect(seenModels).toEqual(["openai/default-model"]);
  });

  test("uses flex service tier for normal model requests by default", async () => {
    let postedBody: any = null;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Privet." } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await generateDraft(
      {
        ...baseRequest,
        rows: [baseRequest.rows[0]!],
        model: "google/gemini-3-flash-preview"
      },
      {
        testMode: false,
        validateModel: async () => {}
      }
    );

    expect(postedBody.service_tier).toBe("flex");
  });

  test("omits service tier for normal model requests when default is selected", async () => {
    let postedBody: any = null;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Privet." } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    await generateDraft(
      {
        ...baseRequest,
        rows: [baseRequest.rows[0]!],
        model: "google/gemini-3-flash-preview",
        serviceTier: "default"
      },
      {
        testMode: false,
        validateModel: async () => {}
      }
    );

    expect("service_tier" in postedBody).toBe(false);
  });

  test("passes matching speaker-lane audio clips into the normal row rewrite context", async () => {
    const audioTracks: AudioCueAudioTrackInput[] = [
      {
        trackId: "lane-1",
        speakerKey: "lane-a",
        trackLabel: "Speaker 1",
        fileName: "lane-1.wav",
        mimeType: "audio/wav",
        bytes: new Uint8Array([1, 2, 3])
      },
      {
        trackId: "lane-2",
        speakerKey: "lane-b",
        trackLabel: "Speaker 2",
        fileName: "lane-2.wav",
        mimeType: "audio/wav",
        bytes: new Uint8Array([4, 5, 6])
      }
    ];
    const seenContexts: RowRewriteContext[] = [];
    const seenSlices: string[] = [];
    const seenAudioModels: string[] = [];

    await generateDraft(
      {
        ...baseRequest,
        rows: [
          { ...baseRequest.rows[0]!, speakerKey: "Speaker 1" },
          { ...baseRequest.rows[1]!, speakerKey: "Speaker 2" }
        ],
        model: "google/gemini-3-flash-preview"
      },
      {
        audioTracks,
        validateAudioModel: async (model) => {
          seenAudioModels.push(model);
        },
        sliceAudio: async ({ track, row }) => {
          seenSlices.push(`${row.rowId}:${track.trackId}`);
          return {
            trackId: track.trackId,
            speakerKey: track.speakerKey,
            trackLabel: track.trackLabel,
            format: "wav",
            base64: Buffer.from(`${row.rowId}:${track.trackId}`).toString("base64")
          };
        },
        rewriteRow: async (context: RowRewriteContext) => {
          seenContexts.push(context);
          return `${context.currentRow.text}.`;
        }
      }
    );

    expect(seenAudioModels).toEqual(["google/gemini-3-flash-preview"]);
    expect(seenSlices).toEqual(["r1:lane-1", "r2:lane-2"]);
    expect(seenContexts.map((context) => context.audioClips?.map((clip) => clip.trackId))).toEqual([
      ["lane-1"],
      ["lane-2"]
    ]);
    expect(seenContexts.every((context) => typeof context.tagSystem === "string" && context.tagSystem.length > 0)).toBe(
      true
    );
  });

  test("batches default audio slicing before normal row rewrites", async () => {
    const audioTracks: AudioCueAudioTrackInput[] = [
      {
        trackId: "lane-1",
        speakerKey: "lane-a",
        trackLabel: "Speaker 1",
        fileName: "lane-1.wav",
        mimeType: "audio/wav",
        bytes: new Uint8Array([1, 2, 3])
      },
      {
        trackId: "lane-2",
        speakerKey: "lane-b",
        trackLabel: "Speaker 2",
        fileName: "lane-2.wav",
        mimeType: "audio/wav",
        bytes: new Uint8Array([4, 5, 6])
      }
    ];
    const batchCalls: string[][] = [];
    const seenContexts: RowRewriteContext[] = [];

    await generateDraft(
      {
        ...baseRequest,
        rows: [
          { ...baseRequest.rows[0]!, speakerKey: "Speaker 1" },
          { ...baseRequest.rows[1]!, speakerKey: "Speaker 2" }
        ],
        model: "google/gemini-3-flash-preview"
      },
      {
        audioTracks,
        validateAudioModel: async () => {},
        sliceAudioBatch: async ({ tasks }) => {
          batchCalls.push(tasks.map((task) => `${task.row.rowId}:${task.track.trackId}`));
          return {
            clipsByRowId: new Map(
              tasks.map((task) => [
                task.row.rowId,
                [
                  {
                    trackId: task.track.trackId,
                    speakerKey: task.track.speakerKey,
                    trackLabel: task.track.trackLabel,
                    format: "wav" as const,
                    base64: Buffer.from(`${task.row.rowId}:${task.track.trackId}`).toString("base64")
                  }
                ]
              ])
            ),
            errorsByRowId: new Map()
          };
        },
        rewriteRow: async (context: RowRewriteContext) => {
          seenContexts.push(context);
          return `${context.currentRow.text}.`;
        }
      }
    );

    expect(batchCalls).toEqual([["r1:lane-1", "r2:lane-2"]]);
    expect(seenContexts.map((context) => context.audioClips?.map((clip) => clip.trackId))).toEqual([
      ["lane-1"],
      ["lane-2"]
    ]);
  });

  test("deduplicates duplicate captured lanes before batch slicing", async () => {
    const audioTracks: AudioCueAudioTrackInput[] = [
      {
        trackId: "lane-1",
        speakerKey: "lane-a",
        trackLabel: "Speaker 1",
        fileName: "lane-1.wav",
        mimeType: "audio/wav",
        bytes: new Uint8Array([1, 2, 3])
      },
      {
        trackId: "lane-1",
        speakerKey: "lane-a",
        trackLabel: "Speaker 1",
        fileName: "lane-1-duplicate.wav",
        mimeType: "audio/wav",
        bytes: new Uint8Array([1, 2, 3])
      }
    ];
    const batchCalls: string[][] = [];
    const seenContexts: RowRewriteContext[] = [];

    await generateDraft(
      {
        ...baseRequest,
        rows: [{ ...baseRequest.rows[0]!, speakerKey: "Speaker 1" }],
        model: "google/gemini-3-flash-preview"
      },
      {
        audioTracks,
        validateAudioModel: async () => {},
        sliceAudioBatch: async ({ tasks }) => {
          batchCalls.push(tasks.map((task) => `${task.row.rowId}:${task.track.trackId}:${task.track.fileName}`));
          return {
            clipsByRowId: new Map([
              [
                "r1",
                [
                  {
                    trackId: "lane-1",
                    speakerKey: "lane-a",
                    trackLabel: "Speaker 1",
                    format: "wav",
                    base64: Buffer.from("r1:lane-1").toString("base64")
                  }
                ]
              ]
            ]),
            errorsByRowId: new Map()
          };
        },
        rewriteRow: async (context: RowRewriteContext) => {
          seenContexts.push(context);
          return `${context.currentRow.text}.`;
        }
      }
    );

    expect(batchCalls).toEqual([["r1:lane-1:lane-1.wav"]]);
    expect(seenContexts[0]?.audioClips?.map((clip) => clip.trackId)).toEqual(["lane-1"]);
  });
});
