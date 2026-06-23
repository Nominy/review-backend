import { afterEach, describe, expect, test } from "bun:test";
import { reviewRedistributionsWithModel, transcribeSegmentWithModel } from "./broker-service";
import type {
  AudioCueAudioTrackInput,
  BrokerRedistributeTextRequest,
  BrokerTranscribeSegmentRequest
} from "./types";

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

describe("reviewRedistributionsWithModel", () => {
  test("reviews every group server-side in parallel and returns ordered per-group results", async () => {
    const pendingResponses: Array<{
      body: any;
      resolve: (response: Response) => void;
    }> = [];

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return await new Promise<Response>((resolve) => {
        pendingResponses.push({ body, resolve });
      });
    }) as unknown as typeof fetch;

    const request: BrokerRedistributeTextRequest = {
      openRouterApiKey: "sk-or-test",
      model: "google/gemini-3-flash-preview",
      serviceTier: "flex",
      groups: [
        {
          groupId: "group-1",
          speakerKey: "Speaker 1",
          fullText: "Первый текст.",
          segments: [
            { id: "s1", index: 0, speakerKey: "Speaker 1", startSeconds: 0, endSeconds: 1, text: "Первый" }
          ],
          draftAllocations: [{ segmentId: "s1", text: "Первый текст." }]
        },
        {
          groupId: "group-2",
          speakerKey: "Speaker 2",
          fullText: "Второй текст.",
          segments: [
            { id: "s2", index: 0, speakerKey: "Speaker 2", startSeconds: 1, endSeconds: 2, text: "Второй" }
          ],
          draftAllocations: [{ segmentId: "s2", text: "Второй текст." }]
        }
      ]
    };

    const responsePromise = reviewRedistributionsWithModel(request, {
      validateModel: async () => {}
    });

    while (pendingResponses.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    pendingResponses[1].resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ acceptDraft: true, moves: [], notes: "second" }) } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    pendingResponses[0].resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ acceptDraft: false, moves: [{ fromIndex: 1, toIndex: 2, sentenceCount: 1 }], notes: "first" }) } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const response = await responsePromise;

    expect(pendingResponses.map((item) => item.body.messages[1].content)).toEqual([
      expect.stringContaining("Group id: group-1"),
      expect.stringContaining("Group id: group-2")
    ]);
    expect(pendingResponses[0].body.messages[0].content).toContain("Return JSON only");
    expect(pendingResponses[0].body.service_tier).toBe("flex");
    expect(response.results).toEqual([
      {
        groupId: "group-1",
        ok: true,
        review: {
          acceptDraft: false,
          moves: [{ fromIndex: 1, toIndex: 2, sentenceCount: 1 }],
          notes: "first"
        },
        model: "google/gemini-3-flash-preview"
      },
      {
        groupId: "group-2",
        ok: true,
        review: {
          acceptDraft: true,
          moves: [],
          notes: "second"
        },
        model: "google/gemini-3-flash-preview"
      }
    ]);
    expect(response.model).toBe("google/gemini-3-flash-preview");
  });
});
