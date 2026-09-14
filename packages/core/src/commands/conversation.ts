import type { Db } from '../db/index.ts';
import { listArtifactsForTicket, listEventsForEntity, listEventsForProject, listTickets } from '../store.ts';
import { extractQuestionText } from './decide.ts';

// Batch 11 part 2, item 4: the page's conversation panel. This deliberately
// mirrors the owner/manager_reply/manager_assessment interleaving
// managerEnvelope.ts's own (private, unexported) buildConversation already
// does for the Manager's OWN prompt -- that file is Role R's, and that
// helper isn't exported, so it can't be imported here. This version is not
// a like-for-like duplicate, though: it also surfaces `request_user_decision`
// questions (as worker_needs_user_decision events on a manager ticket) and
// scope_updated events, neither of which the prompt-building version needs,
// so it earns being a second, UI-shaped read of the same underlying rows
// rather than a second copy of the same function.
export type ConversationEntryKind = 'owner_message' | 'manager_reply' | 'manager_assessment' | 'question' | 'scope_updated';

export interface ConversationEntry {
  kind: ConversationEntryKind;
  text: string;
  createdAt: string;
  /** Only set for kind 'question': the manager ticket to answer via POST /tickets/{id}/decide. */
  ticketId?: string;
  /** Only set for kind 'question': false while its ticket is still BLOCKED on it -- the page shows the answer box only then. */
  answered?: boolean;
}

export function buildConversation(db: Db, projectId: string): ConversationEntry[] {
  const entries: ConversationEntry[] = [];

  for (const e of listEventsForProject(db, projectId)) {
    if (e.eventType === 'discuss') {
      const p = e.payload as { message?: string };
      entries.push({ kind: 'owner_message', text: p.message ?? '', createdAt: e.createdAt });
    } else if (e.eventType === 'scope_updated') {
      const p = e.payload as { summary?: string };
      entries.push({ kind: 'scope_updated', text: p.summary ?? '', createdAt: e.createdAt });
    }
  }

  for (const ticket of listTickets(db, projectId)) {
    if (ticket.kind !== 'manager') continue;

    for (const artifact of listArtifactsForTicket(db, ticket.id)) {
      if (artifact.kind !== 'manager_reply' && artifact.kind !== 'manager_assessment') continue;
      entries.push({ kind: artifact.kind, text: artifact.pathOrUri, createdAt: artifact.createdAt });
    }

    const questionEvents = listEventsForEntity(db, 'ticket', ticket.id)
      .filter((e) => e.eventType === 'worker_needs_user_decision')
      .sort((a, b) => a.sequence - b.sequence);
    questionEvents.forEach((e, i) => {
      const isLatest = i === questionEvents.length - 1;
      entries.push({
        kind: 'question',
        text: extractQuestionText(e.payload),
        createdAt: e.createdAt,
        ticketId: ticket.id,
        // Every question but the most recent one was necessarily answered
        // already -- the ticket could only reach a later worker_needs_user_decision
        // by first leaving BLOCKED via decide(). The most recent one is live
        // only while the ticket is still actually BLOCKED on it.
        answered: isLatest ? ticket.status !== 'BLOCKED' : true,
      });
    });
  }

  return entries.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}
