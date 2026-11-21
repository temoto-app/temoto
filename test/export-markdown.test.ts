/**
 * TODO 1014: Markdown export of a conversation (`exportMarkdown`). Images become only a `[image]` marker, tool_result is not part of the material, and the inside of code blocks is left alone.
 */
import { describe, expect, it } from "vitest";
import { buildExportTurns } from "../src/shared/conversation-export.js";
import {
  exportMarkdown,
  replaceImages,
} from "../src/shared/conversation-export-md.js";
import type { AiosEvent } from "../src/shared/agent.js";

const ev = (
  id: string,
  kind: string,
  payload: unknown,
  extra: object = {},
): AiosEvent =>
  ({ id, ts: 1, kind, payload, ...extra }) as unknown as AiosEvent;

describe("exportMarkdown (TODO 1014)", () => {
  it("発言は引用、回答はそのまま、ターンの間は水平線。tool_result・思考・子エージェントは出ない", () => {
    const turns = buildExportTurns([
      ev("1", "user_text", { text: "質問\n\n二行目" }),
      ev("2", "thinking", { text: "内緒の思考" }),
      ev("3", "tool_result", { toolUseId: "x", text: "SECRET_RESULT" }),
      ev("4", "assistant_text", { text: "回答 **太字**" }),
      ev("5", "assistant_text", { text: "sub" }, { actor: "subagent" }),
    ]);
    const md = exportMarkdown({ title: "題\n名", meta: "aios · now", turns });
    expect(md).toBe(
      "# 題 名\n\naios · now\n\n---\n\n> 質問\n>\n> 二行目\n\n回答 **太字**\n",
    );
    expect(md).not.toContain("内緒");
    expect(md).not.toContain("SECRET_RESULT");
  });

  it("画像の記法は [image] の印だけにし、URI・パスを出さない", () => {
    const md = exportMarkdown({
      title: "t",
      meta: "m",
      turns: [
        {
          number: 1,
          question: null,
          answers: [
            '見て ![図](file:///Users/me/a.png) と ![x][r] と <img src="/b.png" alt="">',
          ],
        },
      ],
    });
    expect(md).toContain("見て [image] と [image] と [image]");
    expect(md).not.toContain("a.png");
    expect(md).not.toContain("b.png");
  });

  it("コードの塊の中の画像の記法は触らない。添付の印は relabel で表示言語に", () => {
    expect(replaceImages("```md\n![a](b.png)\n```\n![a](b.png)")).toBe(
      "```md\n![a](b.png)\n```\n[image]",
    );
    const md = exportMarkdown({
      title: "t",
      meta: "m",
      turns: [
        {
          number: 1,
          question: { id: "1", ts: 1, text: "(添付: a.png)" },
          answers: [],
        },
      ],
      relabel: (text) => text.replace("添付", "attached"),
    });
    expect(md).toContain("> (attached: a.png)");
  });

  it("参照の定義の行と、括弧入り・<…>・title 付きの URL も消える", () => {
    const out = replaceImages(
      "![a][1] と ![b](/Users/alice/a (1).png) と ![c](<my pic.png> \"t\") と ![d](u.png 't') と ![e]\n\n[1]: /Users/alice/Desktop/secret.png\n[e]: x.png\n[ref]: file:///Users/alice/x\n[ok]: https://example.com",
    );
    expect(out).toBe(
      "[image] と [image] と [image] と [image] と [image]\n\n[ok]: https://example.com",
    );
    expect(replaceImages("`![a](b.png)` ![a](b.png)")).toBe(
      "`![a](b.png)` [image]",
    );
    expect(replaceImages("![a](b.png")).toBe("![a](b.png");
  });
});
