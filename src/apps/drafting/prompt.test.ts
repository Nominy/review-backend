import { describe, expect, test } from "bun:test";
import { buildUserPrompt } from "./prompt";
import type { RowRewriteContext } from "./types";

describe("buildUserPrompt", () => {
  test("keeps audio cue guidance conservative when audio clips are present", () => {
    const context: RowRewriteContext = {
      currentRow: {
        rowId: "r1",
        speakerKey: "Speaker 1",
        startSeconds: 1,
        endSeconds: 2,
        text: "privet",
        index: 0
      },
      tagSystem: "[smekh]\n[vzdoh]",
      audioClips: [
        {
          trackId: "lane-1",
          format: "wav",
          base64: "AAAA"
        }
      ]
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("Do not tag ordinary breathing");
    expect(prompt).toContain("Most added audio cues should be laughter tags");
    expect(prompt).toContain("Other audible-event tags are much rarer");
    expect(prompt).toContain("Correct transcript words only when the audio evidence is clear");
    expect(prompt).toContain("Recover a missing short interjection");
    expect(prompt).toContain("never copy speech from a neighboring row");
  });

  test("explains audio tag placement grammar for square, angle, and curly tags", () => {
    const context: RowRewriteContext = {
      currentRow: {
        rowId: "r1",
        speakerKey: "Speaker 1",
        startSeconds: 1,
        endSeconds: 2,
        text: "privet",
        index: 0
      },
      tagSystem: "[смех]\n<смех-в-речи> ... </смех-в-речи>\n{СКАЗ: ...}",
      audioClips: [
        {
          trackId: "lane-1",
          format: "wav",
          base64: "AAAA"
        }
      ]
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("Square-bracket tags like [смех]");
    expect(prompt).toContain("only immediately before the audible event begins");
    expect(prompt).toContain("Angle tags like <смех-в-речи> ... </смех-в-речи>");
    expect(prompt).toContain("wrap exactly the words spoken during that vocal event");
    expect(prompt).toContain("Do not put separate square laughter tags inside an angle-tagged speech span");
    expect(prompt).toContain("Curly-brace tags like {СКАЗ: ...} are not audio-event tags");
    expect(prompt).toContain("Never add a curly-brace tag because of the audio");
  });

  test("discourages mid-row ellipses and almost always avoids М-м", () => {
    const context: RowRewriteContext = {
      currentRow: {
        rowId: "r1",
        speakerKey: "Speaker 1",
        startSeconds: 1,
        endSeconds: 2,
        text: "privet",
        index: 0
      },
      tagSystem: "[СЃРјРµС…]",
      audioClips: [
        {
          trackId: "lane-1",
          format: "wav",
          base64: "AAAA"
        }
      ]
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("Ellipsis rule (strict)");
    expect(prompt).toContain("ONLY legal '...' is at the very start");
    expect(prompt).toContain("previous same-speaker segment ends with '--'");
    expect(prompt).toContain("Almost never write М-м");
    expect(prompt).toContain("Do not use М-м as a generic hesitation");
  });

  test("tells the model to preserve human transcript words", () => {
    const context: RowRewriteContext = {
      currentRow: {
        rowId: "r1",
        speakerKey: "Speaker 1",
        startSeconds: 1,
        endSeconds: 2,
        text: "М.",
        index: 0
      }
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("Do not replace transcript words");
    expect(prompt).toContain("Trust the human-written words over any transcription guess");
    expect(prompt).toContain("Allowed edits without audio are only tags, punctuation, and numeric normalization");
    expect(prompt).not.toContain("Correct transcript words only when the audio evidence is clear");
  });

  test("encourages adding clear audio cue tags instead of ignoring them", () => {
    const context: RowRewriteContext = {
      currentRow: {
        rowId: "r1",
        speakerKey: "Speaker 1",
        startSeconds: 1,
        endSeconds: 2,
        text: "privet",
        index: 0
      },
      tagSystem: "[smekh]\n[kashel]",
      audioClips: [
        {
          trackId: "lane-1",
          format: "wav",
          base64: "AAAA"
        }
      ]
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("When a clear allowed audible cue is present, add the appropriate tag");
    expect(prompt).toContain("Conservative does not mean silently ignoring clear audible events");
    expect(prompt).toContain("Scan the whole attached clip");
  });

  test("includes same-speaker neighbors as context without making them editable", () => {
    const context: RowRewriteContext = {
      currentRow: {
        rowId: "r2",
        speakerKey: "Speaker 1",
        startSeconds: 3,
        endSeconds: 4,
        text: "Текущая.",
        index: 2
      },
      previousRow: {
        rowId: "r1",
        speakerKey: "Speaker 1",
        startSeconds: 1,
        endSeconds: 2,
        text: "До.",
        index: 0
      },
      nextRow: {
        rowId: "r3",
        speakerKey: "Speaker 1",
        startSeconds: 5,
        endSeconds: 6,
        text: "После.",
        index: 4
      }
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain('Предыдущая: time=1-2 text="До."');
    expect(prompt).toContain('Следующая: time=5-6 text="После."');
    expect(prompt).toContain("только для понимания; не копируй из них слова");
  });

  test("requires comma isolation around standalone interjections", () => {
    const context: RowRewriteContext = {
      currentRow: {
        rowId: "r1",
        speakerKey: "Speaker 1",
        startSeconds: 1,
        endSeconds: 2,
        text: "nu ya dumayu",
        index: 0
      }
    };

    const prompt = buildUserPrompt(context);

    expect(prompt).toContain("Comma-isolate standalone interjections and filler particles");
    expect(prompt).toContain("row-start interjection");
    expect(prompt).toContain("middle interjection");
    expect(prompt).toContain("Ну, я думаю");
    expect(prompt).toContain("Я, ну, думаю");
  });
});
