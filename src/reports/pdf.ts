import { deflateSync } from 'node:zlib';

const REGULAR: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584, 761, 556, 556, 222, 556, 333, 1000, 556, 556, 333,
  1000, 667, 333, 1000, 556, 611, 556, 556, 222, 222, 333, 333, 350, 556, 1000,
  333, 1000, 500, 333, 944, 556, 500, 667, 278, 333, 556, 556, 556, 556, 260,
  556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556,
  537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667,
  667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778,
  778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556,
  556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556,
  556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

const BOLD: readonly number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584, 761, 556, 556, 278, 556, 500, 1000, 556, 556, 333,
  1000, 667, 333, 1000, 556, 611, 556, 556, 278, 278, 500, 500, 350, 556, 1000,
  333, 1000, 556, 333, 944, 556, 500, 667, 278, 333, 556, 556, 556, 556, 280,
  556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611,
  556, 278, 333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722,
  722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778,
  778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556,
  556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611,
  611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];

export type PdfFont = 'regular' | 'bold';
export type PdfAlign = 'left' | 'right' | 'center';

export const A4: readonly [number, number] = [595.28, 841.89];

const SPECIAL: Record<number, number> = {
  0x20ac: 0x80,
  0x2026: 0x85,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x2122: 0x99,
};

export function toWinAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    if (code === 9 || code === 10 || code === 13) bytes.push(32);
    else if (code < 32 || code === 127) continue;
    else if (code < 256) bytes.push(code);
    else bytes.push(SPECIAL[code] ?? 63);
  }
  return bytes;
}

function glyphWidth(byte: number, font: PdfFont): number {
  const table = font === 'bold' ? BOLD : REGULAR;
  if (byte < 32) return 0;
  return table[byte - 32] ?? 556;
}

export function textWidth(
  text: string,
  size: number,
  font: PdfFont = 'regular',
): number {
  let units = 0;
  for (const byte of toWinAnsi(text)) units += glyphWidth(byte, font);
  return (units * size) / 1000;
}

export function fitText(
  text: string,
  size: number,
  font: PdfFont,
  maxWidth: number,
): string {
  if (textWidth(text, size, font) <= maxWidth) return text;
  const ellipsis = '...';
  let result = text;
  while (
    result.length > 0 &&
    textWidth(result + ellipsis, size, font) > maxWidth
  )
    result = result.slice(0, -1);
  return result.trimEnd() + ellipsis;
}

export function wrapText(
  text: string,
  size: number,
  font: PdfFont,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && textWidth(candidate, size, font) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function color(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  const value = match ? match[1] : '000000';
  const parts = [0, 2, 4].map((index) =>
    (parseInt(value.slice(index, index + 2), 16) / 255).toFixed(3),
  );
  return parts.join(' ');
}

function escapeString(bytes: number[]): string {
  let out = '';
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c)
      out += '\\' + String.fromCharCode(byte);
    else out += String.fromCharCode(byte);
  }
  return out;
}

function num(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

export interface TextOptions {
  size?: number;
  font?: PdfFont;
  color?: string;
  align?: PdfAlign;
  width?: number;
}

export interface RectOptions {
  fill?: string;
  stroke?: string;
  lineWidth?: number;
}

export class PdfPage {
  readonly commands: string[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  text(
    x: number,
    baseline: number,
    value: string,
    options: TextOptions = {},
  ): void {
    const size = options.size ?? 10;
    const font = options.font ?? 'regular';
    const bytes = toWinAnsi(value);
    if (bytes.length === 0) return;
    let left = x;
    if (options.align === 'right' || options.align === 'center') {
      const width = textWidth(value, size, font);
      const box = options.width ?? 0;
      left =
        options.align === 'right' ? x + box - width : x + (box - width) / 2;
    }
    const y = this.height - baseline;
    this.commands.push(
      `BT /${font === 'bold' ? 'F2' : 'F1'} ${num(size)} Tf ${color(options.color ?? '#000000')} rg ${num(left)} ${num(y)} Td (${escapeString(bytes)}) Tj ET`,
    );
  }

  rect(
    x: number,
    top: number,
    width: number,
    height: number,
    options: RectOptions = {},
  ): void {
    const y = this.height - top - height;
    const parts: string[] = [];
    if (options.fill) parts.push(`${color(options.fill)} rg`);
    if (options.stroke)
      parts.push(
        `${color(options.stroke)} RG ${num(options.lineWidth ?? 0.5)} w`,
      );
    const paint =
      options.fill && options.stroke
        ? 'B'
        : options.fill
          ? 'f'
          : options.stroke
            ? 'S'
            : 'n';
    this.commands.push(
      `${parts.join(' ')} ${num(x)} ${num(y)} ${num(width)} ${num(height)} re ${paint}`.trim(),
    );
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    stroke = '#cccccc',
    lineWidth = 0.5,
  ): void {
    this.commands.push(
      `${color(stroke)} RG ${num(lineWidth)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`,
    );
  }
}

export interface PdfMeta {
  title: string;
  author: string;
  subject?: string;
}

export class PdfDocument {
  readonly pages: PdfPage[] = [];

  constructor(
    private readonly meta: PdfMeta,
    private readonly size: readonly [number, number] = A4,
  ) {}

  addPage(): PdfPage {
    const page = new PdfPage(this.size[0], this.size[1]);
    this.pages.push(page);
    return page;
  }

  toBuffer(now: Date = new Date()): Buffer {
    const pages =
      this.pages.length > 0
        ? this.pages
        : [new PdfPage(this.size[0], this.size[1])];
    const chunks: Buffer[] = [];
    const offsets: number[] = [];
    let position = 0;
    const push = (data: Buffer | string) => {
      const buffer =
        typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
      chunks.push(buffer);
      position += buffer.length;
    };
    const object = (id: number, body: Buffer | string) => {
      offsets[id] = position;
      push(`${id} 0 obj\n`);
      push(body);
      push('\nendobj\n');
    };

    const firstPage = 6;
    const pageIds = pages.map((_, index) => firstPage + index * 2);
    push('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(
      2,
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    );
    object(
      3,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    );
    object(
      4,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    );
    const stamp = `D:${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
    object(
      5,
      `<< /Title (${escapeString(toWinAnsi(this.meta.title))}) /Author (${escapeString(toWinAnsi(this.meta.author))}) /Subject (${escapeString(toWinAnsi(this.meta.subject ?? ''))}) /Creator (Infra Sentinel) /Producer (Infra Sentinel) /CreationDate (${stamp}) >>`,
    );
    pages.forEach((page, index) => {
      const pageId = pageIds[index];
      const contentId = pageId + 1;
      object(
        pageId,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
      );
      const content = deflateSync(
        Buffer.from(page.commands.join('\n'), 'latin1'),
      );
      offsets[contentId] = position;
      push(
        `${contentId} 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`,
      );
      push(content);
      push('\nendstream\nendobj\n');
    });

    const count = firstPage + pages.length * 2;
    const xref = position;
    push(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let id = 1; id < count; id += 1)
      push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    push(
      `trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    );
    return Buffer.concat(chunks);
  }
}
