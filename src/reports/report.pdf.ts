import { formatAvailability, formatSpan } from './availability';
import { formatDay, formatDayTime } from './report.build';
import { fitText, PdfDocument, wrapText, type PdfPage } from './pdf';
import type { SlaReport } from './report.types';

const MARGIN = 40;
const WIDTH = 595.28 - MARGIN * 2;
const BOTTOM = 842 - 56;
const ROW = 19;
const MAX_PDF_INCIDENTS = 60;

const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const ZEBRA = '#f7f8fa';
const CARD = '#f1f4f7';
const BRAND = '#0e7490';
const GOOD = '#15803d';
const BAD = '#b91c1c';

interface Column {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

function drawHeader(page: PdfPage, top: number, columns: Column[]): number {
  page.rect(MARGIN, top, WIDTH, 20, { fill: '#e8edf2' });
  let x = MARGIN;
  for (const column of columns) {
    page.text(x + 6, top + 13.5, column.label, {
      size: 8,
      font: 'bold',
      color: '#374151',
      align: column.align,
      width: column.width - 12,
    });
    x += column.width;
  }
  return top + 20;
}

function drawRow(
  page: PdfPage,
  top: number,
  index: number,
  columns: Column[],
  cells: { text: string; color?: string; bold?: boolean }[],
): number {
  if (index % 2 === 1) page.rect(MARGIN, top, WIDTH, ROW, { fill: ZEBRA });
  let x = MARGIN;
  columns.forEach((column, position) => {
    const cell = cells[position];
    const text = fitText(
      cell.text,
      9,
      cell.bold ? 'bold' : 'regular',
      column.width - 12,
    );
    page.text(x + 6, top + 13, text, {
      size: 9,
      font: cell.bold ? 'bold' : 'regular',
      color: cell.color ?? INK,
      align: column.align,
      width: column.width - 12,
    });
    x += column.width;
  });
  return top + ROW;
}

function card(
  page: PdfPage,
  x: number,
  top: number,
  width: number,
  label: string,
  value: string,
  sub: string,
  color = INK,
): void {
  page.rect(x, top, width, 62, { fill: CARD });
  page.text(x + 10, top + 17, label.toUpperCase(), {
    size: 7.5,
    font: 'bold',
    color: MUTED,
  });
  page.text(x + 10, top + 40, value, { size: 17, font: 'bold', color });
  page.text(x + 10, top + 54, fitText(sub, 8, 'regular', width - 20), {
    size: 8,
    color: MUTED,
  });
}

export function renderReportPdf(report: SlaReport): Buffer {
  const doc = new PdfDocument({
    title: `SLA report - ${report.organization}`,
    author: 'Infra Sentinel',
    subject: report.period.label,
  });
  let page = doc.addPage();
  let top = 0;

  const ensure = (needed: number, columns?: Column[]) => {
    if (top + needed <= BOTTOM) return;
    page = doc.addPage();
    top = MARGIN;
    if (columns) top = drawHeader(page, top, columns);
  };

  page.text(MARGIN, 44, 'INFRA SENTINEL', {
    size: 8,
    font: 'bold',
    color: BRAND,
  });
  page.text(MARGIN, 72, 'SLA report', { size: 24, font: 'bold' });
  page.text(MARGIN, 92, fitText(report.organization, 11, 'bold', WIDTH), {
    size: 11,
    font: 'bold',
  });
  page.text(MARGIN, 107, fitText(report.period.label, 10, 'regular', WIDTH), {
    size: 10,
    color: MUTED,
  });
  page.text(
    MARGIN,
    121,
    `Generated ${formatDayTime(Date.parse(report.generatedAt))}. Target: ${report.target}% availability.`,
    { size: 9, color: MUTED },
  );

  const summary = report.summary;
  const gap = 10;
  const cardWidth = (WIDTH - gap * 3) / 4;
  const metColor =
    summary.evaluated > 0 && summary.met < summary.evaluated ? BAD : GOOD;
  card(
    page,
    MARGIN,
    140,
    cardWidth,
    'Availability',
    formatAvailability(summary.availability),
    `Target ${report.target}%`,
  );
  card(
    page,
    MARGIN + (cardWidth + gap),
    140,
    cardWidth,
    'Downtime',
    formatSpan(summary.downtimeSec * 1000),
    'all components',
  );
  card(
    page,
    MARGIN + (cardWidth + gap) * 2,
    140,
    cardWidth,
    'Incidents',
    String(summary.incidents),
    `${summary.subjects} ${summary.subjects === 1 ? 'component' : 'components'}`,
  );
  card(
    page,
    MARGIN + (cardWidth + gap) * 3,
    140,
    cardWidth,
    'Target met',
    `${summary.met} of ${summary.evaluated}`,
    'components',
    metColor,
  );

  top = 228;
  page.text(MARGIN, top, 'Availability by component', {
    size: 12,
    font: 'bold',
  });
  top += 12;

  const columns: Column[] = [
    { label: 'Component', width: 150 },
    { label: 'Type', width: 48 },
    { label: 'Availability', width: 66, align: 'right' },
    { label: 'Downtime', width: 62, align: 'right' },
    { label: 'Maintenance', width: 66, align: 'right' },
    { label: 'Incidents', width: 44, align: 'right' },
    { label: 'MTTR', width: 49, align: 'right' },
    { label: 'Target', width: 30, align: 'right' },
  ];
  top = drawHeader(page, top, columns);
  if (report.rows.length === 0) {
    page.text(
      MARGIN + 6,
      top + 14,
      'There are no monitors or servers in this report.',
      { size: 9, color: MUTED },
    );
    top += ROW;
  }
  report.rows.forEach((row, index) => {
    ensure(ROW, columns);
    const met = row.met === null ? '-' : row.met ? 'Yes' : 'No';
    top = drawRow(page, top, index, columns, [
      { text: row.name, bold: true },
      { text: row.kind === 'monitor' ? 'Monitor' : 'Server', color: MUTED },
      { text: formatAvailability(row.availability), bold: true },
      { text: formatSpan(row.downtimeSec * 1000) },
      { text: formatSpan(row.maintenanceSec * 1000), color: MUTED },
      { text: String(row.incidents) },
      { text: row.mttrSec === null ? '-' : formatSpan(row.mttrSec * 1000) },
      {
        text: met,
        color: row.met === null ? MUTED : row.met ? GOOD : BAD,
        bold: true,
      },
    ]);
  });

  top += 24;
  ensure(60);
  page.text(MARGIN, top, 'Incidents', { size: 12, font: 'bold' });
  top += 12;
  const incidentColumns: Column[] = [
    { label: '#', width: 30 },
    { label: 'Component', width: 118 },
    { label: 'Incident', width: 140 },
    { label: 'Started (UTC)', width: 100 },
    { label: 'Duration', width: 55, align: 'right' },
    { label: 'Counted', width: 72 },
  ];
  top = drawHeader(page, top, incidentColumns);
  if (report.incidents.length === 0) {
    page.text(MARGIN + 6, top + 14, 'No incidents in this period.', {
      size: 9,
      color: MUTED,
    });
    top += ROW;
  }
  report.incidents.slice(0, MAX_PDF_INCIDENTS).forEach((incident, index) => {
    ensure(ROW, incidentColumns);
    top = drawRow(page, top, index, incidentColumns, [
      { text: String(incident.number), color: MUTED },
      { text: incident.subject, bold: true },
      { text: incident.title },
      {
        text: formatDayTime(Date.parse(incident.startedAt)).replace(' UTC', ''),
        color: MUTED,
      },
      { text: formatSpan(incident.durationSec * 1000) },
      {
        text: incident.countedAsDowntime ? 'Yes' : 'No',
        color: incident.countedAsDowntime ? BAD : MUTED,
      },
    ]);
  });
  const hidden = report.incidents.length - MAX_PDF_INCIDENTS;
  if (hidden > 0 || report.incidentsTruncated) {
    ensure(20);
    page.text(
      MARGIN + 6,
      top + 14,
      hidden > 0
        ? `And ${hidden} more incidents. The CSV export lists all of them.`
        : 'More incidents exist. The CSV export lists them.',
      {
        size: 8.5,
        color: MUTED,
      },
    );
    top += ROW;
  }

  top += 22;
  const note =
    'How this is calculated. Availability is 1 minus downtime divided by measured time. Downtime is the time between an incident opening and the component recovering. ' +
    'Scheduled maintenance windows and paused time are removed from both downtime and measured time. A component is measured from the moment it was created. ' +
    (report.includeDegraded
      ? 'Degraded incidents count as downtime in this report. '
      : 'Degraded incidents do not count as downtime. ') +
    `Period: ${formatDay(Date.parse(report.period.from))} to ${formatDay(Date.parse(report.period.to))}, in UTC.`;
  const lines = wrapText(note, 8, 'regular', WIDTH);
  ensure(lines.length * 11 + 16);
  page.line(MARGIN, top - 8, MARGIN + WIDTH, top - 8, LINE);
  lines.forEach((line, index) =>
    page.text(MARGIN, top + index * 11 + 4, line, { size: 8, color: MUTED }),
  );

  const count = doc.pages.length;
  doc.pages.forEach((current, index) => {
    current.line(MARGIN, 806, MARGIN + WIDTH, 806, LINE);
    current.text(
      MARGIN,
      820,
      fitText(
        `Infra Sentinel SLA report - ${report.organization}`,
        8,
        'regular',
        WIDTH - 80,
      ),
      { size: 8, color: MUTED },
    );
    current.text(MARGIN, 820, `Page ${index + 1} of ${count}`, {
      size: 8,
      color: MUTED,
      align: 'right',
      width: WIDTH,
    });
  });

  return doc.toBuffer(new Date(report.generatedAt));
}
