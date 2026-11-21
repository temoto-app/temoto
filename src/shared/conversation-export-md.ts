/**
 * The pure function that builds the body for saving a conversation as Markdown (`.md`) (TODO 1014, ARCHITECTURE.md 5.1.8).
 *
 * - The material is the same `ExportTurn` as for PDF / HTML (`threads.exportTurns`: only the bodies of the user's messages and the parent's answers. Tool calls,
 *   thinking and `tool_result` are not included to begin with = constraint 10). It does not go through HTML.
 * - Images are neither embedded nor referenced: Markdown `![alt](url)` / `![alt][ref]` / `<img>` are replaced only by the `[image]` mark
 *   (no URI or path is written out). Inside code blocks (```) is left alone.
 * - The user's own messages become quotes (`> `) to tell them from answers. A horizontal rule between turns.
 * - Redaction is done in `exportTurns`, and main applies it again before writing (`ConversationExporter.save`).
 */
import type { ExportTurn } from "./conversation-export.js";

export const EXPORT_IMAGE_MARK = "[image]";

const IMG_TAG = /<img\b[^>]*>/gi;
const REF_DEF = /^\s{0,3}\[([^\]\n]+)\]:\s*(<[^>\n]*>|\S*)/;
const LOCAL_DEST = /^(?:file:|\/|~|[A-Za-z]:[\\/])/i;

/** Reads the destination from after `(` to `)` (`<…>`, nested parentheses, title) and returns the position after `)`. -1 if unreadable. */
function skipDestination(line: string, start: number): number {
  let i = start;
  while (line[i] === " " || line[i] === "\t") i++;
  if (line[i] === "<") {
    const close = line.indexOf(">", i);
    if (close < 0) return -1;
    i = close + 1;
  } else {
    let depth = 0;
    while (i < line.length) {
      const c = line[i] as string;
      if (c === "\\") i += 2;
      else if (c === "(") {
        depth++;
        i++;
      } else if (c === ")") {
        if (depth === 0) break;
        depth--;
        i++;
      } else if (c === " " || c === "\t") break;
      else i++;
    }
  }
  while (line[i] === " " || line[i] === "\t") i++;
  const q = line[i];
  if (q === '"' || q === "'" || q === "(") {
    const end = q === "(" ? ")" : q;
    i++;
    while (i < line.length && line[i] !== end) i += line[i] === "\\" ? 2 : 1;
    if (i >= line.length) return -1;
    i++;
    while (line[i] === " " || line[i] === "\t") i++;
  }
  if (line[i] === ")") return i + 1;
  // For a destination with spaces (`/a (1).png`), look for the closing only by balancing parentheses
  let depth = 0;
  for (let j = start; j < line.length; j++) {
    const c = line[j];
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return j + 1;
      depth--;
    }
  }
  return -1;
}

/** Turns images on one line (outside inline code) into marks. Keys of reference-style images are collected into refs. */
function replaceInlineImages(text: string, refs: Set<string>): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("![", i);
    if (at < 0) break;
    const close = text.indexOf("]", at + 2);
    const alt = close < 0 ? null : text.slice(at + 2, close);
    let end = -1;
    if (close >= 0 && alt !== null) {
      if (text[close + 1] === "(") end = skipDestination(text, close + 2);
      else if (text[close + 1] === "[") {
        const c2 = text.indexOf("]", close + 2);
        if (c2 >= 0) {
          refs.add(
            (c2 === close + 2 ? alt : text.slice(close + 2, c2))
              .trim()
              .toLowerCase(),
          );
          end = c2 + 1;
        }
      } else if (alt.trim() !== "" && !alt.includes("[")) {
        refs.add(alt.trim().toLowerCase()); // ![ref] (shortcut)
        end = close + 1;
      }
    }
    if (end < 0) {
      out += text.slice(i, at + 2);
      i = at + 2;
      continue;
    }
    out += text.slice(i, at) + EXPORT_IMAGE_MARK;
    i = end;
  }
  return (out + text.slice(i)).replace(IMG_TAG, EXPORT_IMAGE_MARK);
}

/** Replaces image notation with marks. Code blocks and inline code are left. Lines defining image references and lines defining local destinations are removed. */
export function replaceImages(markdown: string): string {
  let fence: string | null = null;
  const refs = new Set<string>();
  const lines = markdown.split("\n").map((line) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m !== null) {
      const marker = m[1] ?? "";
      if (fence === null) fence = marker[0] ?? null;
      else if (marker[0] === fence) fence = null;
      return { text: line, code: true };
    }
    if (fence !== null) return { text: line, code: true };
    // Inline code (`…`) is not touched
    const text = line
      .split(/(`+[^`\n]*`+)/)
      .map((part, k) => (k % 2 === 1 ? part : replaceInlineImages(part, refs)))
      .join("");
    return { text, code: false };
  });
  return lines
    .filter(({ text, code }) => {
      if (code) return true;
      const d = REF_DEF.exec(text);
      if (d === null) return true;
      const dest = (d[2] ?? "").replace(/^<|>$/g, "");
      return !(
        refs.has((d[1] ?? "").trim().toLowerCase()) || LOCAL_DEST.test(dest)
      );
    })
    .map((l) => l.text)
    .join("\n");
}

export interface ExportMarkdownInput {
  readonly title: string;
  /** The one line under the heading (working folder name, save date-time). */
  readonly meta: string;
  readonly turns: readonly ExportTurn[];
  /** Puts the attachment marks of the user's messages into the display language. */
  readonly relabel?: (text: string) => string;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function exportMarkdown(input: ExportMarkdownInput): string {
  const relabel = input.relabel ?? ((text: string) => text);
  const out: string[] = [
    `# ${oneLine(input.title)}`,
    "",
    oneLine(input.meta),
    "",
  ];
  for (const turn of input.turns) {
    out.push("---", "");
    if (turn.question !== null) {
      const quoted = replaceImages(relabel(turn.question.text))
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`));
      out.push(...quoted, "");
    }
    for (const answer of turn.answers)
      out.push(replaceImages(answer).replace(/\s+$/, ""), "");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}
