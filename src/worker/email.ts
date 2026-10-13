import type { Env } from './env';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

// A transport exists and the given feature flag (chat notices by default) is on.
export function emailAvailable(env: Env, flag: string | undefined = env.EMAIL_ENABLED): boolean {
  return flag === '1' && Boolean(env.EMAIL || (env.EMAIL_GATEWAY_URL && env.EMAIL_GATEWAY_SECRET));
}

export type ChatNotice = { to: string; workspace: string; sender: string; channel: string; link: string; isDm: boolean };
type Email = { to: string; from: string; subject: string; text: string; html: string };
const defaultSender = 'notifications@mail.awaitchat.com';

export function chatNoticeMessage(notice: ChatNotice): Email {
  const action = notice.isDm ? 'sent you a direct message' : `mentioned you in #${notice.channel}`;
  const subject = notice.isDm ? `${notice.sender} sent you a message on Await` : `${notice.sender} mentioned you on Await`;
  const line = `${notice.sender} ${action} in ${notice.workspace}.`;
  return {
    to: notice.to,
    from: defaultSender,
    subject,
    html: `<p>${escapeHtml(line)}</p><p><a href="${escapeHtml(notice.link)}">Open the conversation</a></p><p>Manage email notifications in Await settings.</p>`,
    text: `${line}\n\nOpen the conversation: ${notice.link}\n\nManage email notifications in Await settings.`,
  };
}

export function signinLinkMessage(to: string, url: string): Email {
  return {
    to,
    from: defaultSender,
    subject: 'Sign in to Await',
    text: `Open this link to sign in to Await:\n\n${url}\n\nThis link expires in 10 minutes and can only be used once. If you did not request it, you can ignore this email.`,
    html: `<p>Open this link to sign in to Await:</p><p><a href="${escapeHtml(url)}">Sign in to Await</a></p><p>This link expires in 10 minutes and can only be used once. If you did not request it, you can ignore this email.</p>`,
  };
}

// Sends through the email gateway when configured, otherwise the Email binding; false when neither exists.
async function deliver(env: Env, message: Email): Promise<boolean> {
  const outgoing = { ...message, from: env.EMAIL_FROM || message.from };
  if (env.EMAIL_GATEWAY_URL && env.EMAIL_GATEWAY_SECRET) {
    const response = await fetch(`${env.EMAIL_GATEWAY_URL}/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.EMAIL_GATEWAY_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify(outgoing),
    });
    if (!response.ok) throw new Error(`Email delivery failed: ${response.status}`);
    return true;
  }
  if (!env.EMAIL) return false;
  await env.EMAIL.send(outgoing);
  return true;
}

export async function sendChatNotice(env: Env, notice: ChatNotice): Promise<boolean> {
  if (env.EMAIL_ENABLED !== '1') return false;
  return deliver(env, chatNoticeMessage(notice));
}

export async function sendSigninLink(env: Env, to: string, url: string): Promise<void> {
  if (env.AUTH_EMAIL_ENABLED !== '1') throw new Error('Email sign-in is not available yet.');
  let sent: boolean;
  try { sent = await deliver(env, signinLinkMessage(to, url)); } catch { throw new Error('Could not send the sign-in link. Try again shortly.'); }
  if (!sent) throw new Error('Email sign-in is not available yet.');
}
