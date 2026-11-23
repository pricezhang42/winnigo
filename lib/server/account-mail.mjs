import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
/**
 * Sends a verification, password-reset or account-deletion link, a note that the address already
 * has an account (`existing`, after a sign-up attempt with it), or a delivery test (`test`, from
 * npm run accounts:check-providers).
 *
 * `WINNIGO_MAIL_MODE=file` writes messages to a private local outbox instead (loopback only),
 * for testing without SMTP. Otherwise SMTP with TLS is required.
 */
export async function sendAccountMail({ to, url, kind }, env = process.env) {
  const subject = {
    verify: 'Verify your Winnigo email',
    reset: 'Reset your Winnigo password',
    delete: 'Confirm your Winnigo account deletion',
    test: 'Winnigo email delivery test',
    existing: 'You already have a Winnigo account',
  }[kind];
  const body =
    kind === 'existing'
      ? `Someone, probably you, tried to create a Winnigo account with this email address. You already have one.\n\nSign in here: ${url}\n\nIf you created your account with Google, choose "Continue with Google". If you forgot your password, choose "Forgot password?" on the same page.\n\nIf this wasn't you, you can ignore this email; nothing has changed.`
      : `${subject}\n\n${url}\n\nIf you did not request this, ignore this email.`;
  if (!subject) throw Error('Invalid account message');
  if (env.WINNIGO_MAIL_MODE === 'file') {
    if (
      !['127.0.0.1', 'localhost', '::1'].includes(env.WINNIGO_HOST) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(env.WINNIGO_ORIGIN).hostname)
    )
      throw Error('Local mail outbox requires loopback');
    const directory = resolve(env.WINNIGO_MAIL_DIR || '.winnigo/mail');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(directory, randomUUID() + '.json'),
      JSON.stringify({ to, url, kind, subject }),
      { mode: 0o600, flag: 'wx' },
    );
    return;
  }
  if (!env.SMTP_HOST || !env.SMTP_FROM) throw Error('Account email delivery is not configured');
  const port = Number(env.SMTP_PORT || 465);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000,
    socketTimeout: 15000,
  });
  await transport.sendMail({
    from: env.SMTP_FROM,
    to,
    subject,
    text: body,
  });
}
