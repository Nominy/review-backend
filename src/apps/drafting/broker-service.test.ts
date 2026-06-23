import { afterEach, describe, expect, test } from "bun:test";
import { reviewRedistributionWithModel, transcribeSegmentWithModel } from "./broker-service";
import type { AudioCueAudioTrackInput, BrokerRedistributeTextRequest, BrokerTranscribeSegmentRequest } from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

describe("transcribeSegmentWithModel", () => {
  test("sends the matching speaker audio clip to OpenRouter and returns Russian text", async () => {
    const seenAudioModels: string[] = [];
    const seenSlices: string[] = [];
    let postedBody: any = null;

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"text\":\"Привет всем.\"}" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const request: BrokerTranscribeSegmentRequest = {
      openRouterApiKey: "sk-or-test",
      model: "google/gemini-3-flash-preview",
      serviceTier: "priority",
      reasoningEffort: "high",
      segment: {
        rowId: "r1",
        speakerKey: "Speaker 1",
        startSeconds: 10,
        endSeconds: 12
      }
    };

    const response = await transcribeSegmentWithModel(request, {
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
          base64: "AAAA"
        };
      }
    });

    expect(seenAudioModels).toEqual(["google/gemini-3-flash-preview"]);
    expect(seenSlices).toEqual(["r1:lane-1"]);
    expect(response).toEqual({
      text: "Привет всем.",
      model: "google/gemini-3-flash-preview"
    });
    expect(postedBody.service_tier).toBe("priority");
    expect(postedBody.reasoning).toEqual({ effort: "high", exclude: true });
    expect(JSON.stringify(postedBody.messages)).toContain("\"type\":\"input_audio\"");
  });
});

describe("reviewRedistributionWithModel", () => {
  test("asks OpenRouter for the Helper redistribution review JSON contract", async () => {
    let postedBody: any = null;

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      postedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  acceptDraft: false,
                  moves: [
                    {
                      fromIndex: 1,
                      toIndex: 2,
                      sentenceCount: 1
                    }
                  ],
                  notes: "Move trailing word."
                })
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

    const request: BrokerRedistributeTextRequest = {
      openRouterApiKey: "sk-or-test",
      model: "google/gemini-3-flash-preview",
      serviceTier: "flex",
      group: {
        groupId: "group-1",
        speakerKey: "Speaker 1",
        fullText: "Привет мир.",
        segments: [
          { id: "s1", index: 0, speakerKey: "Speaker 1", startSeconds: 0, endSeconds: 1, text: "Привет мир" },
          { id: "s2", index: 1, speakerKey: "Speaker 1", startSeconds: 1, endSeconds: 2, text: "" }
        ],
        draftAllocations: [
          { segmentId: "s1", text: "Привет мир" },
          { segmentId: "s2", text: "" }
        ]
      }
    };

    const response = await reviewRedistributionWithModel(request, {
      validateModel: async () => {}
    });

    expect(response.review).toEqual({
      acceptDraft: false,
      moves: [{ fromIndex: 1, toIndex: 2, sentenceCount: 1 }],
      notes: "Move trailing word."
    });
    expect(response.model).toBe("google/gemini-3-flash-preview");
    expect(postedBody.messages[0].content).toContain("Return JSON only");
    expect(postedBody.messages[1].content).toContain("Привет мир.");
    expect(postedBody.service_tier).toBe("flex");
  });
});
