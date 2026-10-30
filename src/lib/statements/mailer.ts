import type { WorkerMailer } from 'worker-mailer';

export class EmailNotConfiguredError extends Error {
  constructor() {
    super('Email is not set up yet. Ask an admin to add the SMTP settings.');
    this.name = 'EmailNotConfiguredError';
  }
}

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachment?: { filename: string; content: Uint8Array };
};

/** SMTP settings from the environment (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM). */
function readConfig() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD;
  const from = process.env.EMAIL_FROM?.trim() || user;
  if (!host || !user || !pass || !from) throw new EmailNotConfiguredError();
  const port = Number(process.env.SMTP_PORT?.trim() || 465);
  // Port 465 uses TLS from the start; 587 upgrades with STARTTLS. SMTP_SECURE overrides the guess.
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE.trim() === 'true' : port === 465;
  return { host, port, secure, user, pass, from };
}

export function emailIsConfigured(): boolean {
  try {
    readConfig();
    return true;
  } catch {
    return false;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * Sends the given emails one by one over a single SMTP connection. Returns how many were accepted and which failed.
 * Uses Workers' own TCP sockets (worker-mailer), which connect by host name; nodemailer resolves the name itself and
 * connects to the raw IP, which Cloudflare Workers refuse ("proxy request failed, cannot connect to the specified address").
 */
export async function sendEmails(emails: OutgoingEmail[]): Promise<{ sent: number; failed: { to: string; reason: string }[] }> {
  const config = readConfig();
  const failed: { to: string; reason: string }[] = [];
  let sent = 0;
  let mailer: WorkerMailer;
  try {
    // Loaded on demand: it needs the Workers-only "cloudflare:sockets" module, which does not exist while Next.js builds.
    const { WorkerMailer: Mailer } = await import('./vendor/worker-mailer.mjs');
    mailer = await Mailer.connect({
      host: config.host,
      port: config.port,
      secure: config.secure,
      startTls: !config.secure,
      credentials: { username: config.user, password: config.pass },
      authType: ['plain', 'login'],
      socketTimeoutMs: 30000,
      responseTimeoutMs: 30000,
    });
  } catch (error) {
    const reason = (error instanceof Error ? error.message : 'Could not connect to the mail server').slice(0, 200);
    return { sent: 0, failed: emails.map(email => ({ to: email.to, reason })) };
  }
  try {
    for (const email of emails) {
      try {
        await mailer.send({
          from: config.from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
          attachments: email.attachment
            ? [{ filename: email.attachment.filename, content: toBase64(email.attachment.content), mimeType: 'application/pdf' }]
            : [],
        });
        sent += 1;
      } catch (error) {
        failed.push({ to: email.to, reason: (error instanceof Error ? error.message : 'Could not send').slice(0, 200) });
      }
    }
  } finally {
    await mailer.close().catch(() => undefined);
  }
  return { sent, failed };
}
