import type { Db } from '../db/index.ts';
import { newId } from '../id.ts';
import { recordTicketTransition } from '../stateMachine.ts';
import { getTicket, listEventsForEntity } from '../store.ts';
import type { Ticket, TicketKind } from '../types.ts';

// `decide --ticket <id> --answer "<text>"`: answers a BLOCKED ticket's
// pending question and unblocks it.
//
// The persisted event_type for this is literally `user_decision` (BLOCKED
// -> READY), per the cross-role contract batch-3-spec.md §2 fixes so Role
// F's envelope work and this command don't need to coordinate: payload
// `{ ticketId, question, answer }`, which is also how scheduler.ts's
// buildEnvelope reads decisions back out for `relevantDecisions`. This is
// the *transition* event, not a separate notification alongside it -- an
// earlier version of this file wrote two events (a `user_decision` record
// plus a `user_decided` transition) because part 1 was written before
// stateMachine.ts had landed the real transition name; `user_decided` was
// never a real event type, and calling it produced a clean
// `InvalidTransitionError` rather than actually deciding anything. Fixed
// here to call the one real transition, `user_decision`.
//
// Visibility/requiresUser are no longer passed explicitly -- stateMachine.ts's
// write site now derives them from `policy.ts`'s `classify(event)` itself.

export class DecideError extends Error {}

// Pulled out so commands/conversation.ts (batch 11 part 2 item 4: the
// page's conversation panel) can show the SAME question text this function
// answers, rather than re-deriving the blockers/summary precedence a second
// time and risking the two disagreeing about what "the question" was.
export function extractQuestionText(payload: unknown): string {
  const p = payload as { blockers?: string[]; summary?: string } | undefined;
  return (p?.blockers && p.blockers.length > 0 ? p.blockers.join('; ') : '') || p?.summary || '';
}

// Ruling 36 (batch 19, mini-phase 2B), amended after the Opus review 2026-09-22
// section 3: the ONE place that decides what "the pending questions" of a
// BLOCKED ticket are, beside extractQuestionText above -- every consumer
// (decide() itself, commands/inbox.ts, commands/conversation.ts) calls this
// instead of re-deriving it. A `worker_needs_user_decision` payload's own
// `questions` array wins ONLY for a MANAGER-kind ticket (managerApply.ts
// writes one entry per request_user_decision command, in proposal order).
// A WORK ticket's `questions` is never consulted here even when non-empty --
// the worker result contract (resultContract.ts's `questions` field) lets a
// real worker fill that array too, and the scheduler stores the whole
// result verbatim as the payload, so trusting it for a work ticket would let
// a worker's own output multiply how many answers decide() demands. A work
// ticket is always exactly one question, as before this ruling. Any other
// payload shape (no `questions` at all -- every event recorded before this
// ruling, and every ordinary worker's payload) falls back to the single text
// extractQuestionText already derives. No migration needed for either case.
export function pendingQuestions(payload: unknown, ticketKind: TicketKind): string[] {
  const p = payload as { questions?: string[] } | undefined;
  if (ticketKind === 'manager' && p?.questions && p.questions.length > 0) return p.questions;
  return [extractQuestionText(payload)];
}

export function decide(db: Db, input: { ticketId: string; answer?: unknown; answers?: unknown }): Ticket {
  const ticket = getTicket(db, input.ticketId);
  if (!ticket) {
    throw new DecideError(`no such ticket: ${input.ticketId}`);
  }
  if (ticket.status !== 'BLOCKED') {
    throw new DecideError(`ticket ${ticket.id} is ${ticket.status}, not BLOCKED; there is nothing to decide`);
  }

  const latestDecisionRequest = listEventsForEntity(db, 'ticket', ticket.id)
    .filter((e) => e.eventType === 'worker_needs_user_decision')
    .sort((a, b) => b.sequence - a.sequence)[0];
  const questions = pendingQuestions(latestDecisionRequest?.payload, ticket.kind);
  const n = questions.length;

  const hasAnswer = input.answer !== undefined;
  const hasAnswers = input.answers !== undefined;

  // `answer` and `answers` are mutually exclusive -- ruling 36: "never both".
  if (hasAnswer && hasAnswers) {
    throw new DecideError('provide either "answer" or "answers", not both');
  }

  // Wrong types (a malformed daemon-route body, not anything the CLI or a
  // well-behaved caller can produce) get this one sentence, not a TypeError
  // thrown mid-transaction.
  if (hasAnswer && typeof input.answer !== 'string') {
    throw new DecideError('"answer" must be a string');
  }
  if (hasAnswers && !(Array.isArray(input.answers) && input.answers.every((a) => typeof a === 'string'))) {
    throw new DecideError('"answers" must be an array of strings');
  }

  let decisions: Array<{ question: string; answer: string }>;
  if (hasAnswers) {
    const answers = input.answers as string[];
    if (answers.length !== n || answers.some((a) => a.trim().length === 0)) {
      throw new DecideError(`ticket ${ticket.id} has ${n} pending question(s); "answers" must have exactly ${n} non-empty entries (got ${answers.length})`);
    }
    decisions = questions.map((question, i) => ({ question, answer: answers[i] }));
  } else if (hasAnswer) {
    // Opus review amendment: a single `answer` is legal for ANY N, not just
    // N === 1 -- it is ONE combined answer to every pending question at
    // once (the pre-2B behaviour), recorded as a single `decisions` entry
    // whose question is the joined text. This is the shape the page sends
    // until mini-phase 3B, and the shape the inbox's own `decide --answer`
    // hint has always offered; refusing it here would strand every
    // multi-question Manager ticket. An empty string is legal too (the
    // route has always accepted it on purpose).
    decisions = [{ question: questions.join('; '), answer: input.answer as string }];
  } else {
    throw new DecideError(`ticket ${ticket.id} has ${n} pending question(s); provide "answer" (one combined answer) or "answers" with exactly ${n} entries`);
  }

  // All N are submitted together, in one `user_decision` transition -- still
  // the ONE write site, ONE event type. `question`/`answer` keep the joined,
  // `; `-separated texts so a pre-2B reader (buildDecisionLog, scheduler.ts's
  // relevantDecisions, before this ruling's own changes to them) still reads
  // sense; `decisions` is the new per-question pairing.
  const question = decisions.map((d) => d.question).join('; ');
  const answer = decisions.map((d) => d.answer).join('; ');

  recordTicketTransition(db, {
    ticketId: ticket.id,
    event: 'user_decision',
    idempotencyKey: newId('evt'),
    payload: { ticketId: ticket.id, question, answer, decisions },
  });

  return getTicket(db, ticket.id)!;
}
