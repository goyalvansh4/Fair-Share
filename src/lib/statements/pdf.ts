import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';
import { categoryLabels } from '../expenses/categories';
import { type Statement } from './build';

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 40;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const INK = rgb(0.13, 0.14, 0.2);
const MUTED = rgb(0.45, 0.47, 0.55);
const BRAND = rgb(0.43, 0.36, 0.91);
const LINE = rgb(0.9, 0.91, 0.94);
const ZEBRA = rgb(0.972, 0.975, 0.985);
const POSITIVE = rgb(0.13, 0.52, 0.36);
const NEGATIVE = rgb(0.74, 0.46, 0.19);

/** Standard PDF fonts only cover Latin-1; anything else becomes "?" instead of crashing the whole statement. */
export function safeText(value: string): string {
  let result = '';
  for (const char of value.replace(/[\r\n\t]+/g, ' ')) {
    const code = char.codePointAt(0) ?? 0;
    result += (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? char : '?';
  }
  return result;
}

/** Money for the PDF: "INR 1,234.00" (the rupee sign is not in the standard fonts). */
export function pdfMoney(amountMinor: number, currency: string): string {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(amountMinor) / 10 ** digits);
  return `${amountMinor < 0 ? '-' : ''}${currency} ${formatted}`;
}

function formatDay(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`));
}

type Column<Row> = {
  header: string;
  width: number;
  align?: 'left' | 'right';
  value: (row: Row) => string;
  color?: (row: Row) => ReturnType<typeof rgb>;
};

class StatementWriter {
  private pages: PDFPage[] = [];
  private page!: PDFPage;
  private y = 0;

  constructor(
    private doc: PDFDocument,
    private regular: PDFFont,
    private bold: PDFFont,
    private title: string,
  ) {
    this.newPage();
  }

  private newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pages.push(this.page);
    this.y = PAGE.height - MARGIN;
    if (this.pages.length > 1) {
      this.text(this.title, MARGIN, this.y, 9, this.regular, MUTED);
      this.page.drawLine({ start: { x: MARGIN, y: this.y - 8 }, end: { x: PAGE.width - MARGIN, y: this.y - 8 }, thickness: 0.5, color: LINE });
      this.y -= 28;
    }
  }

  text(value: string, x: number, y: number, size: number, font: PDFFont, color = INK) {
    this.page.drawText(safeText(value), { x, y, size, font, color });
  }

  private fit(value: string, size: number, font: PDFFont, maxWidth: number): string {
    const text = safeText(value);
    if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
    let end = text.length;
    while (end > 1 && font.widthOfTextAtSize(`${text.slice(0, end)}...`, size) > maxWidth) end -= 1;
    return `${text.slice(0, end)}...`;
  }

  ensure(space: number) {
    if (this.y - space < MARGIN + 24) this.newPage();
  }

  gap(amount: number) {
    this.y -= amount;
  }

  brandHeader(organizationName: string, periodLabel: string, generated: string) {
    this.text('FairShare', MARGIN, this.y, 11, this.bold, BRAND);
    const label = 'MONTHLY STATEMENT';
    this.text(label, PAGE.width - MARGIN - this.bold.widthOfTextAtSize(label, 9), this.y + 1, 9, this.bold, MUTED);
    this.y -= 34;
    this.text(this.fit(organizationName, 22, this.bold, CONTENT_WIDTH), MARGIN, this.y, 22, this.bold);
    this.y -= 22;
    this.text(periodLabel, MARGIN, this.y, 13, this.regular, MUTED);
    this.y -= 15;
    this.text(`Generated ${generated}`, MARGIN, this.y, 9, this.regular, MUTED);
    this.y -= 22;
  }

  summary(items: { label: string; value: string }[]) {
    const gap = 10;
    const width = (CONTENT_WIDTH - gap * (items.length - 1)) / items.length;
    const height = 54;
    items.forEach((item, index) => {
      const x = MARGIN + index * (width + gap);
      this.page.drawRectangle({ x, y: this.y - height, width, height, color: ZEBRA, borderColor: LINE, borderWidth: 0.8 });
      this.text(item.label, x + 12, this.y - 18, 9, this.regular, MUTED);
      this.text(this.fit(item.value, 15, this.bold, width - 24), x + 12, this.y - 39, 15, this.bold);
    });
    this.y -= height + 22;
  }

  notice(message: string) {
    const lines = this.wrap(message, 10, this.regular, CONTENT_WIDTH - 24);
    const height = lines.length * 14 + 16;
    this.ensure(height + 10);
    this.page.drawRectangle({ x: MARGIN, y: this.y - height, width: CONTENT_WIDTH, height, color: rgb(1, 0.97, 0.91), borderColor: rgb(0.93, 0.8, 0.55), borderWidth: 0.8 });
    lines.forEach((line, index) => this.text(line, MARGIN + 12, this.y - 20 - index * 14, 10, this.regular, rgb(0.5, 0.33, 0.07)));
    this.y -= height + 16;
  }

  private wrap(value: string, size: number, font: PDFFont, maxWidth: number): string[] {
    const words = safeText(value).split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) current = candidate;
      else { lines.push(current); current = word; }
    }
    if (current) lines.push(current);
    return lines;
  }

  heading(value: string) {
    this.ensure(60);
    this.text(value, MARGIN, this.y, 13, this.bold);
    this.y -= 8;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE.width - MARGIN, y: this.y }, thickness: 1, color: BRAND });
    this.y -= 18;
  }

  paragraph(value: string) {
    this.ensure(30);
    this.wrap(value, 10, this.regular, CONTENT_WIDTH).forEach(line => {
      this.text(line, MARGIN, this.y, 10, this.regular, MUTED);
      this.y -= 14;
    });
    this.y -= 8;
  }

  table<Row>(columns: Column<Row>[], rows: Row[]) {
    const rowHeight = 20;
    const headerRow = () => {
      this.ensure(rowHeight * 2);
      let x = MARGIN;
      for (const column of columns) {
        const w = this.bold.widthOfTextAtSize(safeText(column.header), 8.5);
        this.text(column.header, column.align === 'right' ? x + column.width - 6 - w : x + 6, this.y - 13, 8.5, this.bold, MUTED);
        x += column.width;
      }
      this.page.drawLine({ start: { x: MARGIN, y: this.y - rowHeight }, end: { x: PAGE.width - MARGIN, y: this.y - rowHeight }, thickness: 0.8, color: LINE });
      this.y -= rowHeight;
    };
    headerRow();
    rows.forEach((row, index) => {
      if (this.y - rowHeight < MARGIN + 24) {
        this.newPage();
        headerRow();
      }
      if (index % 2 === 1) this.page.drawRectangle({ x: MARGIN, y: this.y - rowHeight, width: CONTENT_WIDTH, height: rowHeight, color: ZEBRA });
      let x = MARGIN;
      for (const column of columns) {
        const text = this.fit(column.value(row), 9.5, this.regular, column.width - 12);
        const w = this.regular.widthOfTextAtSize(text, 9.5);
        this.text(text, column.align === 'right' ? x + column.width - 6 - w : x + 6, this.y - 14, 9.5, this.regular, column.color?.(row) ?? INK);
        x += column.width;
      }
      this.y -= rowHeight;
    });
    this.y -= 16;
  }

  finish() {
    const total = this.pages.length;
    this.pages.forEach((page, index) => {
      const label = `Page ${index + 1} of ${total}`;
      page.drawText(label, { x: PAGE.width - MARGIN - this.regular.widthOfTextAtSize(label, 8.5), y: 24, size: 8.5, font: this.regular, color: MUTED });
      page.drawText(safeText('Generated by FairShare. Payment records track user-reported transfers and do not move money.'), { x: MARGIN, y: 24, size: 8.5, font: this.regular, color: MUTED });
    });
  }
}

/** Renders the statement as an A4 PDF. */
export async function renderStatementPdf(statement: Statement): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(safeText(`${statement.organizationName} - ${statement.period.label} statement`));
  doc.setProducer('FairShare');
  doc.setCreator('FairShare');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const writer = new StatementWriter(doc, regular, bold, `${statement.organizationName} - ${statement.period.label}`);
  const money = (amount: number) => pdfMoney(amount, statement.currency);

  writer.brandHeader(
    statement.organizationName,
    statement.period.label,
    new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(statement.generatedAt),
  );
  writer.summary([
    { label: 'Total spent this month', value: money(statement.totalSpendMinor) },
    { label: 'Expenses recorded', value: String(statement.expenseCount) },
    { label: 'People', value: String(statement.memberLines.length) },
  ]);
  if (statement.warning) {
    writer.notice(`Balances are not shown because the records do not reconcile: ${statement.warning}. Please review recent expense edits.`);
  }

  writer.heading(`Balances at the end of ${statement.period.label}`);
  if (statement.warning || !statement.memberLines.length) {
    writer.paragraph('No balances to show.');
  } else {
    writer.table(
      [
        { header: 'MEMBER', width: 150, value: line => line.name + (line.active ? '' : ' (left)') },
        { header: 'PAID THIS MONTH', width: 95, align: 'right', value: line => money(line.paidMinor) },
        { header: 'SHARE THIS MONTH', width: 100, align: 'right', value: line => money(line.shareMinor) },
        {
          header: 'POSITION',
          width: CONTENT_WIDTH - 345,
          align: 'right',
          value: line => line.closingNetMinor > 0 ? `Gets back ${money(line.closingNetMinor)}` : line.closingNetMinor < 0 ? `Owes ${money(-line.closingNetMinor)}` : 'Settled up',
          color: line => line.closingNetMinor > 0 ? POSITIVE : line.closingNetMinor < 0 ? NEGATIVE : INK,
        },
      ],
      statement.memberLines,
    );
  }

  writer.heading('Who pays whom');
  if (statement.warning) writer.paragraph('Not available until the records reconcile.');
  else if (!statement.transfers.length) writer.paragraph('Everyone is settled up. Nobody owes anyone.');
  else {
    writer.table(
      [
        { header: 'FROM', width: 190, value: transfer => transfer.fromName },
        { header: 'TO', width: 190, value: transfer => transfer.toName },
        { header: 'AMOUNT', width: CONTENT_WIDTH - 380, align: 'right', value: transfer => money(transfer.amountMinor) },
      ],
      statement.transfers,
    );
  }

  writer.heading(`Expenses in ${statement.period.label}`);
  if (!statement.expenses.length) writer.paragraph('No expenses were recorded this month.');
  else {
    writer.table(
      [
        { header: 'DATE', width: 70, value: expense => formatDay(expense.expense_date) },
        { header: 'DESCRIPTION', width: 170, value: expense => expense.title },
        { header: 'CATEGORY', width: 90, value: expense => categoryLabels[expense.category] ?? expense.category },
        { header: 'PAID BY', width: 95, value: expense => expense.payerName },
        { header: 'AMOUNT', width: CONTENT_WIDTH - 425, align: 'right', value: expense => money(expense.amount_minor) },
      ],
      statement.expenses,
    );
  }

  if (statement.payments.length) {
    writer.heading(`Payments in ${statement.period.label}`);
    writer.table(
      [
        { header: 'DATE', width: 70, value: payment => formatDay(payment.date) },
        { header: 'FROM', width: 140, value: payment => payment.fromName },
        { header: 'TO', width: 140, value: payment => payment.toName },
        { header: 'STATUS', width: 70, value: payment => payment.status[0].toUpperCase() + payment.status.slice(1) },
        { header: 'AMOUNT', width: CONTENT_WIDTH - 420, align: 'right', value: payment => money(payment.amount_minor) },
      ],
      statement.payments,
    );
  }

  writer.finish();
  return doc.save();
}
