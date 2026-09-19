import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db } from './db/index.ts';
import { newId } from './id.ts';
import { classify } from './policy.ts';
import { countManagerRunsSince, createTicket, getProject, insertEvent } from './store.ts';
import type { Project } from './types.ts';

// Batch 11 (docs/strategy/batch-11-spec.md section 2, Role R; route-revision-
// scope-document.md section 4): the Manager's two entry points, per the
// cross-role contract with Role Q -- "Role Q calls ONLY these":
//   planProject(db, projectId, { budgetUsd? })      -> creates and returns a manager ticket id
//   discussProject(db, projectId, message, { budgetUsd? }) -> same
// Neither function ticks or spawns anything itself, matching every other
// direct-write command in this codebase (commands/plan.ts's planMission,
// `ticket add`, `dep add`) -- a live daemon picks the new READY ticket up on
// its own next periodic pass.

export class ManagerError extends Error {}

// Batch 11 item 1: this project has no existing notion of "a project's own
// directory" independent of the DIRECTORY workspace type's
// project.workspace_root (itself optional, required only for DIRECTORY-mode
// tickets -- see workspace.ts). The spec describes `scope_path` as
// defaulting to "SCOPE.md under the project directory," but inventing a
// location here (e.g. under the daemon's state directory, paths.ts) would
// either duplicate or contradict whatever Role Q's `project create --scope`/
// default-path CLI work (batch-11-spec.md section 2, Role Q part 2 item 4)
// decides that phrase means -- and paths.ts is Role Q's file, not this
// role's to extend. So: NO default location is computed anywhere in this
// module. `project.scopePath` is the single source of truth; null means "no
// scope file yet" and reads as empty text, exactly like a genuinely empty
// file would. See setProjectScopePath (store.ts) for the setter Role Q's
// CLI/route wiring is expected to call.

// Reads the CURRENT scope document fresh off disk -- never cached, never
// carried across invocations, the same "rebuild from the database (and, now,
// its referenced files) on every call" discipline batch 0's cost ruling
// established for the rest of the Manager's envelope (managerEnvelope.ts).
// Ruling 29 (batch 16 addendum 5): a project with no scope_path, or whose
// file does not exist (ENOENT), is `{ text: '', status: 'absent' }` -- an
// empty scope is a valid, expected state (interview mode), and callers can
// now TELL "absent" from "present but empty". ANY OTHER read error (a
// permissions problem, a directory at that path, ...) THROWS: it used to be
// swallowed into `''`, which made an unreadable document indistinguishable
// from an empty one and had the Manager interview the owner about a scope
// they had already written (rule 9). Nothing downstream may turn an error
// into an empty string.
export function readScopeText(project: Project): { text: string; status: 'present' | 'absent' } {
  if (!project.scopePath) return { text: '', status: 'absent' };
  try {
    return { text: readFileSync(project.scopePath, 'utf8'), status: 'present' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', status: 'absent' };
    throw err;
  }
}

// The `update_scope` command's write site (managerApply.ts) and
// ensureScopeFile below both funnel through this: writes the file WHOLE (no
// patch/diff shape, matching the command's own doc comment), creating the
// parent directory if it does not exist yet.
export function writeScopeText(project: Project, content: string): void {
  if (!project.scopePath) {
    throw new ManagerError('cannot write scope text: this project has no scope_path set');
  }
  mkdirSync(dirname(project.scopePath), { recursive: true });
  writeFileSync(project.scopePath, content, 'utf8');
}

// "created empty when absent" (batch-11-spec.md section 2, Role R item 1):
// called once per Manager invocation, before the envelope is built, so a
// scope_path pointing at a file that was never actually written yet gets
// one. Distinct from readScopeText, which only reports an ENOENT as `absent`
// -- this is what actually creates the file the owner can then find and
// hand-edit.
export function ensureScopeFile(project: Project): void {
  if (!project.scopePath) return;
  if (existsSync(project.scopePath)) return;
  mkdirSync(dirname(project.scopePath), { recursive: true });
  writeFileSync(project.scopePath, '', 'utf8');
}

// Batch 11 item 3: "a per-project daily maximum of Manager invocations,
// default twenty." Enforced at exactly one point -- scheduler.ts's tick(),
// right before it would spawn a READY manager-kind ticket -- not here at
// ticket-creation time. Reasoning: a Manager invocation's actual cost is
// incurred at spawn, not at creation, and tick() is the one place every path
// that can produce a READY manager ticket converges -- a fresh
// planProject/discussProject call, AND a `decide` that unblocks an existing
// manager ticket already sitting BLOCKED from a request_user_decision
// (managerApply.ts's own comment: answering it "returns the manager ticket
// to READY, where the next tick re-runs the Manager" -- no code in this
// file's two entry points runs on that path at all). Gating creation here
// as well would still miss that second path, so scheduler.ts is the single
// enforcement point; MANAGER_DAILY_CAP_DEFAULT and countManagerRunsSince
// (store.ts) are exported/kept here only because they are Manager-domain
// constants, not because this file itself checks the cap.
export const MANAGER_DAILY_CAP_DEFAULT = 20;

export function isManagerDailyCapReached(db: Db, projectId: string, now: Date, cap: number = MANAGER_DAILY_CAP_DEFAULT): boolean {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  return countManagerRunsSince(db, projectId, since) >= cap;
}

const TITLE_MAX_CHARS = 60;

function deriveTitle(prefix: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return prefix;
  if (trimmed.length <= TITLE_MAX_CHARS) return `${prefix}: ${trimmed}`;
  const cut = trimmed.slice(0, TITLE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  const truncated = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${prefix}: ${truncated}…`;
}

function invokeManager(db: Db, projectId: string, input: { ownerMessage?: string; budgetUsd?: number }): string {
  const project = getProject(db, projectId);
  if (!project) {
    throw new ManagerError(`no such project: ${projectId}`);
  }

  ensureScopeFile(project);

  if (input.ownerMessage !== undefined) {
    // Batch 11 item 3: "discussProject records the owner's message as a
    // `discuss` event" -- recorded on the PROJECT (not any one ticket),
    // since a conversation spans every Manager invocation over the
    // project's lifetime, the same reasoning setProjectBrief/user_decision's
    // project-scoped decision log already uses. managerEnvelope.ts reads
    // this back, interleaved with the Manager's own manager_reply/
    // manager_assessment artifacts, to build the conversation transcript.
    const policy = classify('discuss');
    insertEvent(db, {
      projectId,
      eventType: 'discuss',
      entityType: 'project',
      entityId: projectId,
      payload: { message: input.ownerMessage },
      visibility: policy.visibility,
      requiresUser: policy.requiresUser,
      idempotencyKey: newId('evt'),
    });
  }

  const title = input.ownerMessage !== undefined ? deriveTitle('Manager: discuss', input.ownerMessage) : 'Manager: plan';
  const ticket = createTicket(db, {
    projectId,
    title,
    description: input.ownerMessage ?? null,
    kind: 'manager',
    workspaceType: 'NONE',
    maxBudgetUsdOverride: input.budgetUsd,
  });
  return ticket.id;
}

export function planProject(db: Db, projectId: string, opts: { budgetUsd?: number } = {}): string {
  return invokeManager(db, projectId, { budgetUsd: opts.budgetUsd });
}

export function discussProject(db: Db, projectId: string, message: string, opts: { budgetUsd?: number } = {}): string {
  if (!message.trim()) {
    throw new ManagerError('a message is required');
  }
  return invokeManager(db, projectId, { ownerMessage: message, budgetUsd: opts.budgetUsd });
}
