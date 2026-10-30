import { type Statement } from './build';
import { pdfMoney } from './pdf';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Subject, plain text and HTML for the monthly statement email. The full ledger travels in the attached PDF. */
export function composeStatementEmail(statement: Statement): { subject: string; text: string; html: string } {
  const money = (amount: number) => pdfMoney(amount, statement.currency);
  const subject = `${statement.organizationName}: ${statement.period.label} statement`;

  const balanceLines = statement.warning
    ? []
    : statement.memberLines.map(line => ({
      name: line.name + (line.active ? '' : ' (left)'),
      text: line.closingNetMinor > 0 ? `gets back ${money(line.closingNetMinor)}` : line.closingNetMinor < 0 ? `owes ${money(-line.closingNetMinor)}` : 'is settled up',
    }));
  const transferLines = statement.transfers.map(transfer => `${transfer.fromName} pays ${transfer.toName} ${money(transfer.amountMinor)}`);
  const summary = `${money(statement.totalSpendMinor)} spent across ${statement.expenseCount} ${statement.expenseCount === 1 ? 'expense' : 'expenses'} in ${statement.period.label}.`;

  const text = [
    `${statement.organizationName} - ${statement.period.label}`,
    '',
    summary,
    '',
    ...(statement.warning ? [`Balances are not shown because the records do not reconcile: ${statement.warning}.`, ''] : []),
    ...(balanceLines.length ? ['Where everyone stands:', ...balanceLines.map(line => `- ${line.name} ${line.text}`), ''] : []),
    ...(transferLines.length ? ['Who pays whom:', ...transferLines.map(line => `- ${line}`), ''] : statement.warning ? [] : ['Everyone is settled up.', '']),
    'The full statement is attached as a PDF.',
    '',
    'Sent by FairShare. Payment records track user-reported transfers and do not move money.',
  ].join('\n');

  const listItems = (items: string[]) => items.length ? `<ul style="margin:8px 0 16px;padding-left:20px">${items.map(item => `<li style="margin:4px 0">${item}</li>`).join('')}</ul>` : '';
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f8fb;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#202238">
<div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff;border:1px solid #e9ebf1;border-radius:12px">
<p style="margin:0;color:#6d5ce8;font-weight:700">FairShare</p>
<h1 style="margin:8px 0 4px;font-size:22px">${escapeHtml(statement.organizationName)}</h1>
<p style="margin:0 0 16px;color:#6f7385">${escapeHtml(statement.period.label)} statement</p>
<p style="margin:0 0 16px;font-size:16px"><strong>${escapeHtml(summary)}</strong></p>
${statement.warning ? `<p style="padding:10px 12px;border-radius:8px;background:#fff7e8;color:#8a5a14">Balances are not shown because the records do not reconcile: ${escapeHtml(statement.warning)}.</p>` : ''}
${balanceLines.length ? `<p style="margin:0;font-weight:700">Where everyone stands</p>${listItems(balanceLines.map(line => `${escapeHtml(line.name)} ${escapeHtml(line.text)}`))}` : ''}
${transferLines.length ? `<p style="margin:0;font-weight:700">Who pays whom</p>${listItems(transferLines.map(escapeHtml))}` : statement.warning ? '' : '<p>Everyone is settled up. Nobody owes anyone.</p>'}
<p style="margin:16px 0 0;color:#6f7385">The full statement is attached as a PDF.</p>
<p style="margin:16px 0 0;color:#9a9dab;font-size:12px">Sent by FairShare. Payment records track user-reported transfers and do not move money.</p>
</div></body></html>`;
  return { subject, text, html };
}
