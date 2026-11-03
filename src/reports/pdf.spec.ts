import { inflateSync } from 'node:zlib';
import { fitText, PdfDocument, textWidth, toWinAnsi, wrapText } from './pdf';
import { buildSlaReport } from './report.build';
import { renderReportPdf } from './report.pdf';

function contentStreams(pdf: Buffer): string[] {
  const text = pdf.toString('latin1');
  const result: string[] = [];
  const pattern = /\nstream\n/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const start = match.index + match[0].length;
    const end = text.indexOf('\nendstream', start);
    result.push(inflateSync(pdf.subarray(start, end)).toString('latin1'));
  }
  return result;
}

describe('pdf text metrics', () => {
  it('measures Helvetica text', () => {
    expect(textWidth('A', 10)).toBeCloseTo(6.67, 2);
    expect(textWidth('AA', 10)).toBeCloseTo(13.34, 2);
    expect(textWidth('i', 10, 'bold')).toBeCloseTo(2.78, 2);
    expect(textWidth('Hello', 12, 'bold')).toBeGreaterThan(
      textWidth('Hello', 12, 'regular'),
    );
  });

  it('maps text to WinAnsi bytes', () => {
    expect(toWinAnsi('Aé')).toEqual([65, 233]);
    expect(toWinAnsi('a–b')).toEqual([97, 0x96, 98]);
    expect(toWinAnsi('中')).toEqual([63]);
    expect(toWinAnsi('a\tb')).toEqual([97, 32, 98]);
  });

  it('truncates and wraps to a width', () => {
    const fitted = fitText(
      'A very long component name that does not fit',
      9,
      'regular',
      100,
    );
    expect(fitted.endsWith('...')).toBe(true);
    expect(textWidth(fitted, 9, 'regular')).toBeLessThanOrEqual(100);
    expect(fitText('Short', 9, 'regular', 100)).toBe('Short');
    const lines = wrapText(
      'one two three four five six seven eight nine ten eleven twelve',
      10,
      'regular',
      90,
    );
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines)
      expect(textWidth(line, 10, 'regular')).toBeLessThanOrEqual(90);
    expect(lines.join(' ')).toBe(
      'one two three four five six seven eight nine ten eleven twelve',
    );
  });
});

describe('PdfDocument', () => {
  it('writes a well formed file with a correct cross reference table', () => {
    const doc = new PdfDocument({ title: 'Test (1)', author: 'Me' });
    const first = doc.addPage();
    first.text(40, 60, 'Hello (world) \\ back', { size: 12, font: 'bold' });
    first.rect(40, 80, 100, 20, { fill: '#ff0000' });
    first.line(40, 120, 200, 120);
    doc.addPage().text(40, 60, 'Second page');
    const pdf = doc.toBuffer(new Date('2026-01-02T03:04:05Z'));
    const text = pdf.toString('latin1');

    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('D:20260102030405Z');
    expect(text).toContain('/Title (Test \\(1\\))');

    const startxref = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const entries = text
      .slice(startxref)
      .split('\n')
      .filter((line) => /^\d{10} 00000 n/.test(line));
    expect(entries.length).toBe(9);
    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(
        `${index + 1} 0 obj`,
      );
    });

    const streams = contentStreams(pdf);
    expect(streams).toHaveLength(2);
    expect(streams[0]).toContain('(Hello \\(world\\) \\\\ back) Tj');
    expect(streams[0]).toContain('/F2 12 Tf');
    expect(streams[1]).toContain('(Second page) Tj');
  });

  it('aligns text to the right and the center of a box', () => {
    const doc = new PdfDocument({ title: 't', author: 'a' });
    const page = doc.addPage();
    page.text(100, 50, 'abc', { size: 10, align: 'right', width: 100 });
    const expected = 100 + 100 - textWidth('abc', 10);
    expect(page.commands[0]).toContain(
      `${Math.round(expected * 100) / 100} 791.89 Td`,
    );
  });
});

describe('renderReportPdf', () => {
  it('lists every component and numbers the pages', () => {
    const now = Date.UTC(2026, 5, 15);
    const day = 86_400_000;
    const subjects = Array.from({ length: 70 }, (_, index) => ({
      kind: 'monitor' as const,
      id: `m${index}`,
      name: `Monitor ${index} (prod)`,
      tags: [],
      createdAt: now - 100 * day,
      paused: [],
      incidents: [],
    }));
    const report = buildSlaReport({
      organization: 'Acme',
      period: {
        from: now - 30 * day,
        to: now,
        label: 'Last 30 days',
        days: 30,
      },
      now,
      target: 99.9,
      includeDegraded: false,
      subjects,
      windows: [],
    });
    const pdf = renderReportPdf(report);
    const all = contentStreams(pdf).join('\n');
    expect(all).toContain('(SLA report) Tj');
    expect(all).toContain('(Monitor 69 \\(prod\\)) Tj');
    const count = Number(/\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1]);
    expect(count).toBeGreaterThan(1);
    expect(all).toContain(`(Page 1 of ${count}) Tj`);
    expect(all).toContain(`(Page ${count} of ${count}) Tj`);
    expect(all).toContain('(No incidents in this period.) Tj');
  });
});
