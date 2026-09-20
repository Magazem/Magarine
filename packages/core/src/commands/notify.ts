import { spawn } from 'node:child_process';
import { consumeEventStream, daemonRequest, type StreamedEvent } from '../daemonClient.ts';
import type { EventRow } from '../types.ts';
import { reasonFor } from './inbox.ts';

// Batch 17 item 4b (docs/strategy/batch-17-addendum-1-ruling-30-amended.md,
// decision 3): Needs You reaches the owner as a Windows toast raised by the
// HOST, not by the page. A page-raised Notification cannot focus our window
// (Windows starts a new browser on the owner's DEFAULT profile) and makes Edge
// ignore a graceful close -- so the page is forbidden from raising one and
// this host does it, off the daemon's existing `/events` stream.
//
// What it promises: within seconds of a `worker_needs_user_decision` or
// `worker_needs_review` event, a toast with the ticket's title and the inbox
// item's one-line message; nothing for any other event; the text never on a
// command line (it goes to PowerShell on STDIN, the discipline token.ts holds
// for the clipboard -- a ticket title is the owner's own words and argv is
// readable by every process on their machine). What it does NOT promise: that
// clicking the toast focuses or opens anything (it has no launch action, on
// purpose -- a click that does nothing beats one that opens a stray window),
// any sender name other than "Windows PowerShell" (a real one needs a
// registered application identity, the installer's job), or anything off
// Windows.

export const TOAST_EVENT_TYPES = ['worker_needs_user_decision', 'worker_needs_review'] as const;
export const TOAST_TITLE = 'Magarine needs you';

export interface Toast {
  title: string;
  body: string;
}

/** The toast for one streamed event, or null when the event is not one that needs the owner. */
export function toastFor(event: StreamedEvent, ticketTitle: string | undefined): Toast | null {
  if (!(TOAST_EVENT_TYPES as readonly string[]).includes(event.event)) return null;
  const row = event.data as Partial<EventRow> | null;
  if (!row || typeof row !== 'object') return null;
  const ticketId = typeof row.entityId === 'string' ? row.entityId : undefined;
  // The very line the inbox shows for this event, so the toast and the inbox
  // can never say two things about the same request.
  const message = reasonFor(event.event, row.payload, ticketId);
  return { title: TOAST_TITLE, body: `${ticketTitle ?? ticketId ?? 'a task'}\n${message}` };
}

// ---- raising the toast ---------------------------------------------------------

/** The seam a test injects to prove the text goes on stdin and never in `args`. `args` is always the fixed list below. */
export type RunPowerShell = (args: string[], input: string) => Promise<{ ok: boolean }>;

// The script is FIXED text: it reads the toast's title and body as JSON from
// stdin and builds the toast through the XML DOM (setting InnerText, so
// nothing the owner wrote is ever parsed as markup). No `launch`/activation
// attribute: a click does nothing. The AppUserModelID is PowerShell's own,
// which is what makes the sender "Windows PowerShell".
const TOAST_SCRIPT = [
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
  '$d = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
  '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
  "$x.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text></text><text></text></binding></visual></toast>')",
  "$t = $x.GetElementsByTagName('text')",
  '$t.Item(0).InnerText = [string]$d.title',
  '$t.Item(1).InnerText = [string]$d.body',
  "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show((New-Object Windows.UI.Notifications.ToastNotification $x))',
].join('\n');

export const TOAST_POWERSHELL_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(TOAST_SCRIPT, 'utf16le').toString('base64'),
];

function realRunPowerShell(args: string[], input: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    // Its own deadline: a toast that hangs must not outlive the host.
    const timer = setTimeout(() => ps.kill(), 15_000);
    ps.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 });
    });
    ps.once('error', () => {
      clearTimeout(timer);
      resolve({ ok: false });
    });
    ps.stdin.on('error', () => {});
    ps.stdin.end(input, 'utf8');
  });
}

export async function raiseToast(toast: Toast, run: RunPowerShell = realRunPowerShell): Promise<boolean> {
  return (await run(TOAST_POWERSHELL_ARGS, JSON.stringify(toast))).ok;
}

// ---- the consumer -------------------------------------------------------------------

export interface NotifierSeams {
  /** The daemon's `/events` stream, from the beginning (the notifier skips what happened before it started). */
  events: (signal: AbortSignal) => AsyncIterable<StreamedEvent>;
  ticketTitle: (projectId: string, ticketId: string) => Promise<string | undefined>;
  raise: (toast: Toast) => Promise<boolean>;
  sayError: (line: string) => void;
  now: () => number;
}

/**
 * One toast per qualifying event that happens AFTER this starts (an item
 * already waiting when the host attaches is in the inbox and the window title;
 * re-announcing history on every launch would be noise). Ends when the stream
 * ends (the daemon is gone) or the signal aborts, never throws into the host,
 * and a toast that fails to raise does not stop the ones after it.
 */
export async function runNotifier(seams: NotifierSeams, signal: AbortSignal): Promise<void> {
  const startedAt = seams.now();
  try {
    for await (const event of seams.events(signal)) {
      if (signal.aborted) return;
      if (!(TOAST_EVENT_TYPES as readonly string[]).includes(event.event)) continue;
      const row = event.data as Partial<EventRow> | null;
      const createdAt = row && typeof row.createdAt === 'string' ? Date.parse(row.createdAt) : NaN;
      if (Number.isFinite(createdAt) && createdAt < startedAt) continue;
      let title: string | undefined;
      try {
        if (row && typeof row.projectId === 'string' && typeof row.entityId === 'string') title = await seams.ticketTitle(row.projectId, row.entityId);
      } catch {
        // The id is a fine fallback for a title that could not be looked up.
      }
      const toast = toastFor(event, title);
      if (toast) await seams.raise(toast).catch(() => false);
    }
  } catch (err) {
    if (signal.aborted) return;
    seams.sayError(`notifications stopped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The production wiring: the existing `consumeEventStream` with the bearer header, the board route for titles, PowerShell for the toast. Windows only. */
export function realNotifierSeams(info: { port: number; token: string }, sayError: (line: string) => void, raise: (toast: Toast) => Promise<boolean> = raiseToast): NotifierSeams {
  return {
    events: (signal) => consumeEventStream(info, { since: 0, signal }),
    async ticketTitle(projectId, ticketId) {
      const res = await daemonRequest<{ tickets?: Array<{ id: string; title: string }> }>(info, 'GET', `/board?project=${encodeURIComponent(projectId)}`);
      return res.body?.tickets?.find((t) => t.id === ticketId)?.title;
    },
    raise,
    sayError,
    now: Date.now,
  };
}
