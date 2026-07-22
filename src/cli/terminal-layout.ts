const ANSI_PATTERN = /(?:\[[0-?]*[ -/]*[@-~]|\][^]*(?:|\\))/gu;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function graphemes(value: string): readonly string[] {
  return Array.from(graphemeSegmenter.segment(value), (entry) => entry.segment);
}

export function displayWidth(value: string): number {
  return graphemes(stripAnsi(value)).reduce((width, grapheme) => width + graphemeWidth(grapheme), 0);
}

export function truncateEnd(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width === 1) return "…";
  const plain = stripAnsi(value);
  return `${takeWidth(plain, width - 1)}…`;
}

export function truncateMiddle(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width <= 3) return truncateEnd(value, width);
  const plain = stripAnsi(value);
  const available = width - 1;
  const leftWidth = Math.ceil(available / 2);
  const rightWidth = Math.floor(available / 2);
  return `${takeWidth(plain, leftWidth)}…${takeWidthFromEnd(plain, rightWidth)}`;
}

export function padDisplay(value: string, width: number): string {
  const fitted = truncateEnd(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - displayWidth(fitted)))}`;
}

export function wrapText(value: string, width: number): readonly string[] {
  if (width <= 0) return [""];
  const paragraphs = value.split(/\r?\n/u);
  return paragraphs.flatMap((paragraph) => {
    if (paragraph.length === 0) return [""];
    const words = paragraph.split(/\s+/u);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const pieces = displayWidth(word) <= width
        ? [word]
        : splitToWidth(word, width);
      for (const piece of pieces) {
        const candidate = line.length === 0 ? piece : `${line} ${piece}`;
        if (displayWidth(candidate) <= width) {
          line = candidate;
        } else {
          if (line.length > 0) lines.push(line);
          line = piece;
        }
      }
    }
    if (line.length > 0) lines.push(line);
    return lines.length === 0 ? [""] : lines;
  });
}

export function terminalColumns(fallback = 80): number {
  const columns = process.stdout.columns;
  return Number.isSafeInteger(columns) && columns !== undefined && columns > 0 ? columns : fallback;
}

export function terminalRows(fallback = 24): number {
  const rows = process.stdout.rows;
  return Number.isSafeInteger(rows) && rows !== undefined && rows > 0 ? rows : fallback;
}

export function repeatToWidth(character: string, width: number): string {
  if (width <= 0 || character.length === 0) return "";
  const characterWidth = displayWidth(character);
  if (characterWidth <= 0) return "";
  const repetitions = Math.floor(width / characterWidth);
  const remainder = width - repetitions * characterWidth;
  return `${character.repeat(repetitions)}${takeWidth(stripAnsi(character), remainder)}`;
}

export function isPlainTerminal(): boolean {
  return process.env.TERM === "dumb" || process.env.COPE_ASCII === "1";
}

export interface TerminalTakeoverOptions {
  readonly inputIsTTY?: boolean;
  readonly outputIsTTY?: boolean;
  readonly term?: string;
  readonly fullscreen?: boolean;
}

export interface TerminalOutput {
  write(value: string): unknown;
}

const TERMINAL_TAKEOVER_START = "\x1b[?1049h\x1b[0m\x1b[?25h\x1b[H";
const TERMINAL_TAKEOVER_END = "\x1b[0m\x1b[?25h\x1b[?1049l";

export function commandUsesTerminalTakeover(command: string, json: boolean, fullscreen = process.env.COPE_FULLSCREEN === "1"): boolean {
  return fullscreen && !json && (command === "interactive" || command === "demo");
}

/** Uses the terminal's alternate screen only after an explicit fullscreen opt-in. */
export function beginTerminalTakeover(
  output: TerminalOutput,
  options: TerminalTakeoverOptions = {},
): () => void {
  const inputIsTTY = options.inputIsTTY ?? process.stdin.isTTY === true;
  const outputIsTTY = options.outputIsTTY ?? process.stdout.isTTY === true;
  const term = options.term ?? process.env.TERM;
  const fullscreen = options.fullscreen ?? process.env.COPE_FULLSCREEN === "1";
  if (!fullscreen || !inputIsTTY || !outputIsTTY || term === "dumb") return () => undefined;

  output.write(TERMINAL_TAKEOVER_START);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    output.write(TERMINAL_TAKEOVER_END);
  };
}

function takeWidth(value: string, width: number): string {
  let result = "";
  let used = 0;
  for (const grapheme of graphemes(value)) {
    const next = graphemeWidth(grapheme);
    if (used + next > width) break;
    result += grapheme;
    used += next;
  }
  return result;
}

function splitToWidth(value: string, width: number): readonly string[] {
  const pieces: string[] = [];
  let rest = value;
  while (rest.length > 0) {
    const piece = takeWidth(rest, width);
    if (piece.length === 0) break;
    pieces.push(piece);
    rest = graphemes(rest).slice(graphemes(piece).length).join("");
  }
  return pieces;
}

function takeWidthFromEnd(value: string, width: number): string {
  const parts = [...graphemes(value)];
  let result = "";
  let used = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const grapheme = parts[index]!;
    const next = graphemeWidth(grapheme);
    if (used + next > width) break;
    result = `${grapheme}${result}`;
    used += next;
  }
  return result;
}

function graphemeWidth(grapheme: string): number {
  if (grapheme.length === 0) return 0;
  if (/^[\p{Mark}‍︎️]+$/u.test(grapheme)) return 0;
  if (/^[​‌‍‎‏‪-‮⁠-⁤⁦-⁯﻿]+$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  if (/^\p{Regional_Indicator}{2}$/u.test(grapheme)) return 2;
  if (/^[#*0-9]️?⃣$/u.test(grapheme)) return 2;
  const codePoint = grapheme.codePointAt(0) ?? 0;
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) return 2;
  return 1;
}
