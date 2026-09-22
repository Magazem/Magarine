import { ARTIFACT_KINDS, type ArtifactKind } from './resultContract.ts';
import { MIN_BUDGET_USD, PROFILE_AND_MODEL_EXCLUSIVE_MESSAGE } from './store.ts';
import type { ExpectedArtifact, TicketStatus } from './types.ts';

// The Manager's typed command schema, per docs/strategy/batch-9-spec.md
// section 2 ("The command schema, exactly the document's list") -- FIVE
// commands originally. If a sixth would be useful, that is a decision for
// the Strategist, not something this file grows on its own -- which is
// exactly what happened for batch 11 (docs/strategy/batch-11-spec.md section
// 2, Role R items 1 and 4): `update_project_brief` is REMOVED (the scope
// document, written whole via `update_scope`, replaces it -- see
// route-revision-scope-document.md section 4 item 2's "`update_project_brief`
// ... becomes this command"), and `update_scope`, `cancel_ticket` and
// `update_ticket` are ADDED, for seven total.
//
// This is the security boundary of the whole Manager feature: an LLM's own
// output is untrusted input, no different in kind from a form submission,
// and the one thing standing between a malformed or actively adversarial
// proposal and the board is `validateProposal` below. Validate the WHOLE
// proposal before any of it is applied (scheduler.ts's post-success step
// does this inside one transaction) -- "apply the good ones" is explicitly
// rejected by the spec, because a half-applied plan is worse than no plan
// and impossible to reason about afterward.

export interface CreateTicketCommand {
  type: 'create_ticket';
  title: string;
  description: string;
  acceptance_criteria: string[];
  /**
   * Each entry resolves to either an existing ticket's id, or the `title`
   * of another `create_ticket` command within this SAME proposal -- never a
   * not-yet-existing ticket's id, since the daemon hasn't generated one
   * until the command is actually applied. See `validateProposal`'s
   * dependency-resolution pass.
   */
  depends_on?: string[];
  // Batch 13 ruling 1a: "agents do not decide where work lives" -- there is
  // deliberately no `workspace_type` field here any more. A work ticket
  // always runs in the project's one directory (store.ts's createTicket
  // default is now DIRECTORY); validateCommandShape rejects a raw proposal
  // that smuggles the key in anyway, the same defensive pattern
  // update_ticket already used for "status" (see that command's own
  // comment). `NONE` is still reachable, just never through a Manager
  // proposal -- only `ticket add --workspace NONE`, an explicit owner
  // action.
  model?: string;
  /** Batch 12 item 3: required whenever `model` is set (see validateCommandShape) -- the Manager's own one-line justification for the choice, recorded on the ticket and shown on the board. */
  model_reason?: string;
  /** Batch 19 mini-phase 2A (ruling 37): a worker profile's NAME, never an id (see validateCommandShape's shape check and the review fix on ProposalBoard.resolveActiveProfileByName). Mutually exclusive with `model` -- store.ts's `PROFILE_AND_MODEL_EXCLUSIVE_MESSAGE` -- must resolve through the board's `resolveActiveProfileByName` (an unknown or retired name is refused). */
  profile?: string;
  /** Batch 19 mini-phase 2A: required whenever `profile` is set (see validateCommandShape), same pairing rule `model_reason` already has with `model`. */
  profile_reason?: string;
  max_budget_usd?: number;
  /** Batch 15 item 4: the ticket's own declared expectation of what DONE must have produced -- see types.ts's ExpectedArtifact. Absent means no such list at all, keeping today's rule (batch 13 ruling 1c). */
  expected_artifacts?: ExpectedArtifact[];
}

export interface AddDependencyCommand {
  type: 'add_dependency';
  /** Both fields reference EXISTING tickets by id -- never a title, and never a ticket this same proposal is about to create (use `create_ticket.depends_on` for that; see its doc comment for why). */
  ticket_id: string;
  depends_on_ticket_id: string;
}

export interface ChangePriorityCommand {
  type: 'change_priority';
  ticket_id: string;
  priority: number;
}

export interface RequestUserDecisionCommand {
  type: 'request_user_decision';
  question: string;
  context: string;
}

// Batch 11: replaces `update_project_brief`. Writes the scope document
// (SCOPE.md, or wherever `projects.scope_path` points) WHOLE -- there is no
// patch/diff shape, matching `update_project_brief`'s own all-or-nothing
// semantics before it. See managerApply.ts's applier for the
// `scope_updated` decision event this also records.
export interface UpdateScopeCommand {
  type: 'update_scope';
  content: string;
}

// Batch 11 item 4: targets an EXISTING ticket by id, never a title and
// never a same-proposal create_ticket (same resolution rule
// add_dependency/change_priority already use). May not target a manager
// ticket (this file's own extension of the existing manager/work security
// boundary -- see validateSemantics) or a ticket already in a terminal or
// otherwise non-cancellable state (see the `cancel` transition's own
// TRANSITIONS table in stateMachine.ts: only OPEN, READY, IN_PROGRESS and
// REVIEW accept it) -- caught here, at validation time, rather than left to
// throw an InvalidTransitionError out of the application transaction.
export interface CancelTicketCommand {
  type: 'cancel_ticket';
  ticket_id: string;
}

// Batch 11 item 4: every field optional, and there is deliberately no
// `status` field on this type at all -- "never status" (this role's brief,
// verbatim) is enforced by the shape itself, not by a runtime check that
// could be forgotten. validateCommandShape still rejects a raw payload that
// smuggles a `status` key in anyway, so a hallucinating Manager gets a
// validation error back to correct from, rather than the key being silently
// ignored. May not target a manager ticket, same boundary as
// `cancel_ticket` above.
export interface UpdateTicketCommand {
  type: 'update_ticket';
  ticket_id: string;
  title?: string;
  description?: string;
  acceptance_criteria?: string[];
  max_budget_usd?: number;
  model?: string;
  /** Batch 12 item 3: required whenever `model` is set, same rule as create_ticket's own field above. */
  model_reason?: string;
  /** Batch 19 mini-phase 2A (ruling 37): same shape and validation as create_ticket's own field above. May not be set on a ticket that is IN_PROGRESS or REVIEW (validateSemantics) -- a run may already be using the ticket's current profile. There is no way to CLEAR a profile through a proposal, matching every other optional field on this command. */
  profile?: string;
  /** Batch 19 mini-phase 2A: required whenever `profile` is set, same rule as create_ticket's own field above. */
  profile_reason?: string;
  /** Batch 15 item 4: same shape and validation as create_ticket's own field above. Absent leaves the ticket's existing list untouched (store.ts's updateTicketFields); there is no way to CLEAR one through a proposal, matching every other optional field on this command. */
  expected_artifacts?: ExpectedArtifact[];
}

export type ManagerCommand =
  | CreateTicketCommand
  | AddDependencyCommand
  | ChangePriorityCommand
  | RequestUserDecisionCommand
  | UpdateScopeCommand
  | CancelTicketCommand
  | UpdateTicketCommand;

export interface Proposal {
  commands: ManagerCommand[];
  rationale: string;
}

// Caps, per batch-9-spec.md section 2: "Caps of twenty commands and fifteen
// creates ... because an LLM proposing a dependency cycle would deadlock the
// board permanently." The cycle check below is the other half of that
// sentence; these caps bound the blast radius of a single Manager run
// regardless of whether it also happens to be well-formed.
export const MAX_COMMANDS = 20;
export const MAX_CREATE_TICKET_COMMANDS = 15;

// Human-readable restatement of the five command shapes above, for the
// Manager's own prompt (managerEnvelope.ts). Kept here, next to the types it
// describes, rather than hand-duplicated in the envelope module, so a future
// change to one of the five commands has one obvious place its prompt text
// needs to change too.
export const MANAGER_COMMAND_SCHEMA_DESCRIPTION = `A proposal is a JSON object: { "commands": [...], "rationale": "<string>" }.
At most ${MAX_COMMANDS} commands total, at most ${MAX_CREATE_TICKET_COMMANDS} of them "create_ticket". Every command must be one of exactly these seven shapes -- no others exist:

- { "type": "create_ticket", "title": "<string>", "description": "<string>", "acceptance_criteria": ["<string>", ...], "depends_on"?: ["<existing ticket id or another create_ticket's title in this same proposal>", ...], "model"?: "<string>", "model_reason"?: "<string, required whenever model is set>", "profile"?: "<a worker profile's name, case-insensitive>", "profile_reason"?: "<string, required whenever profile is set>", "max_budget_usd"?: <number>, "expected_artifacts"?: [{ "kind": "file", "path": "<string>" } | { "kind": "text" | "url" | "reference" }, ...] }
- { "type": "add_dependency", "ticket_id": "<existing ticket id>", "depends_on_ticket_id": "<existing ticket id>" }
- { "type": "change_priority", "ticket_id": "<existing ticket id>", "priority": <number> }
- { "type": "request_user_decision", "question": "<string>", "context": "<string>" }
- { "type": "update_scope", "content": "<string, the WHOLE scope document, replacing what is there now>" }
- { "type": "cancel_ticket", "ticket_id": "<existing, non-manager ticket id>" }
- { "type": "update_ticket", "ticket_id": "<existing, non-manager ticket id>", "title"?: "<string>", "description"?: "<string>", "acceptance_criteria"?: ["<string>", ...], "max_budget_usd"?: <number>, "model"?: "<string>", "model_reason"?: "<string, required whenever model is set>", "profile"?: "<a worker profile's name, case-insensitive>", "profile_reason"?: "<string, required whenever profile is set>", "expected_artifacts"?: [{ "kind": "file", "path": "<string>" } | { "kind": "text" | "url" | "reference" }, ...] } -- never "status"; a ticket's status has exactly one write site and a proposal may never set it directly

"depends_on" on create_ticket may name another create_ticket's title in THIS proposal (that ticket has no id yet) or an existing ticket's id. "add_dependency", "change_priority", "cancel_ticket" and "update_ticket" may only name an EXISTING ticket's id, never a title. A dependency cycle, anywhere in the combined graph of the existing board plus this proposal, rejects the whole proposal. A manager ticket and a work ticket may never depend on each other, and "cancel_ticket"/"update_ticket" may never target a manager ticket. "cancel_ticket" may only target a ticket that is not already DONE, FAILED or CANCELLED. Setting "model" on create_ticket or update_ticket without a non-empty "model_reason" is rejected: if you choose a model deliberately, say why in one line. "profile" assigns a worker from the roster instead of a bare model -- it is only valid for a profile whose name (case-insensitive) is active and not retired, "profile" and "model" may never both be set on the same command (choose a profile or a model, not both), setting "profile" without a non-empty "profile_reason" is rejected the same way an unexplained "model" is, and update_ticket may not change "profile" on a ticket that is currently IN_PROGRESS or REVIEW. Neither command accepts "workspace_type" -- every work ticket runs in the project's own one directory; there is no choice to make here. "expected_artifacts", when set on create_ticket or update_ticket, declares what DONE must have produced: each entry names a "kind" ("file", "text", "url", "reference", "manager_reply" or "manager_assessment"), and only kind "file" carries a "path" -- a declared file the worker does not produce fails the run, naming that file. Tickets with no "expected_artifacts" at all keep the ordinary rule ("done" requires at least one delivered artefact, no more specific check). The whole proposal is validated before any of it is applied: one invalid command rejects everything, not just that command.`;

const COMMAND_TYPES = new Set<ManagerCommand['type']>([
  'create_ticket',
  'add_dependency',
  'change_priority',
  'request_user_decision',
  'update_scope',
  'cancel_ticket',
  'update_ticket',
]);

// Statuses the `cancel` transition actually accepts, per stateMachine.ts's
// TRANSITIONS table -- DONE, FAILED and CANCELLED have no `cancel` entry at
// all, so recordTicketTransition would throw InvalidTransitionError for any
// of them. Duplicated here (rather than imported) deliberately: this file
// validates a Manager's OWN typed command schema and must not depend on
// stateMachine.ts's transition table shape to stay in sync automatically --
// a change to that table is a decision for whoever edits it, not something
// this validator should silently follow.
const CANCELLABLE_STATUSES = new Set<TicketStatus>(['OPEN', 'READY', 'IN_PROGRESS', 'REVIEW']);

// Batch 19 mini-phase 2A (ruling 37): "update_ticket changing the profile of
// a ticket that is IN_PROGRESS or REVIEW" is refused -- a run under the
// ticket's CURRENT profile may already be in flight (IN_PROGRESS) or awaiting
// verification (REVIEW), and store.ts's own resolution (resolveModel) is only
// ever consulted again at the NEXT spawn, so changing the profile out from
// under a live run would silently strand it on a stale value until then.
const PROFILE_LOCKED_STATUSES = new Set<TicketStatus>(['IN_PROGRESS', 'REVIEW']);

// The board data validateProposal needs, deliberately narrow (the compact
// shape scheduler.ts's envelope builder already produces for the Manager's
// own prompt, per batch-9-spec.md section 2 -- this is not a coincidence,
// the same read serves both). `kind` is what makes the manager/work
// cross-dependency rule enforceable without a second DB round trip per
// command.
export interface ProposalBoardTicket {
  id: string;
  title: string;
  kind: 'work' | 'manager';
  /** Batch 11: needed for `cancel_ticket`'s own status check (see CANCELLABLE_STATUSES) -- the one field this board shape gained beyond batch 9's original id/title/kind. */
  status: TicketStatus;
  /** Batch 19 mini-phase 2A review fix (High 1): the ticket's CURRENT bare-model override (null if it has none), so update_ticket's profile/model exclusivity can be validated against the RESULTING row -- this plus whichever of the two fields the command itself sets -- not just whether the command sets both in the same breath. Optional (rather than required) only so a test board that does not care about this rule can omit it; managerApply.ts's real buildProposalBoard always sets it. Absent is read the same as null (no override). */
  model?: string | null;
  /** Batch 19 mini-phase 2A review fix (High 1): the ticket's CURRENT profile id (null if it has none), same reasoning and same "absent reads as null" convention as `model` above. */
  profileId?: string | null;
}

export interface ProposalBoardDependency {
  ticketId: string;
  dependsOnTicketId: string;
}

export interface ProposalBoard {
  tickets: ProposalBoardTicket[];
  dependencies: ProposalBoardDependency[];
  /** Batch 11 item 1: whether `projects.scope_path` is set. `update_scope`'s applier (managerApply.ts) writes straight to that path and throws if it is null -- checked here, at validation time, so a project with no scope file yet produces a clean, retryable validation error instead of an unhandled throw escaping the application transaction. */
  hasScopePath: boolean;
  /**
   * Batch 19 mini-phase 2A review fix (High 2 / Low 5): resolves a `profile`
   * command field to an id, or undefined for "no such ACTIVE profile by
   * that name" -- covering both "does not exist" and "is retired" with one
   * answer, the same way `store.ts`'s `getWorkerProfileByName` already
   * does, because managerApply.ts's real implementation of this callback
   * IS that function. Deliberately the board's OWN lookup, not a second,
   * independently-folded name comparison in this file: the review found
   * that a hand-rolled `toLocaleLowerCase()` fold here (Unicode-aware)
   * disagreed with the store's SQL `COLLATE NOCASE` fold (ASCII-only) for a
   * name like "Éditeur"/"éditeur" -- the validator accepted it, then
   * store.ts's own resolution threw NoSuchWorkerProfileError out of the
   * apply transaction. Calling the exact same function here makes that
   * disagreement structurally impossible, not just less likely. Name only,
   * never an id, per ruling 37's grammar (`getWorkerProfileByName` has no
   * id-lookup half to begin with).
   */
  resolveActiveProfileByName: (name: string) => { id: string } | undefined;
}

export type ProposalValidationResult =
  | { valid: true; data: Proposal }
  | { valid: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// Batch 15 item 4: shared by create_ticket and update_ticket -- the proposal
// validator rejects a malformed `expected_artifacts` list before any of it
// reaches store.ts. Reuses resultContract.ts's own ARTIFACT_KINDS enum
// rather than a second, independently-maintained kind list: this is the
// same set a WORKER's own declared artifacts must belong to, so the two can
// never drift out of sync with each other. Only kind 'file' carries a
// `path` (non-empty, required); every other kind must NOT carry one --
// there is nothing for a non-file kind's path to mean, and accepting one
// silently would just be ignored later, which this project's own standing
// rule treats as a defect to prevent rather than tolerate quietly.
// `fieldLabel` is what the CALLER wrote: the Manager's proposals say
// `<command>.expected_artifacts`, but `POST /tickets` takes camelCase
// `expectedArtifacts`, and an error naming a field the caller never wrote
// sends them looking for it (batch 16 item 6).
export function validateExpectedArtifacts(value: unknown, prefix: string, fieldLabel: string = `${prefix}.expected_artifacts`): string[] {
  if (!Array.isArray(value)) {
    return [`${fieldLabel} must be an array when present`];
  }
  const errors: string[] = [];
  value.forEach((entry, i) => {
    const entryPrefix = `${fieldLabel}[${i}]`;
    if (!isPlainObject(entry) || typeof entry.kind !== 'string') {
      errors.push(`${entryPrefix} must be an object with a string "kind"`);
      return;
    }
    if (!(ARTIFACT_KINDS as readonly string[]).includes(entry.kind)) {
      errors.push(`${entryPrefix}.kind "${entry.kind}" is not one of ${ARTIFACT_KINDS.join(', ')}`);
      return;
    }
    if (entry.kind === ('file' satisfies ArtifactKind)) {
      if (typeof entry.path !== 'string' || entry.path.length === 0) {
        errors.push(`${entryPrefix} with kind "file" must have a non-empty string "path"`);
      }
    } else if (entry.path !== undefined) {
      errors.push(`${entryPrefix} with kind "${entry.kind}" must not have a "path" -- only kind "file" carries one`);
    }
  });
  return errors;
}

// Batch 19 mini-phase 2A (ruling 37): the structural half of "profile"'s
// rules, shared by create_ticket and update_ticket (the same DRY reason
// "model"/"model_reason" already share nothing duplicated between the two
// cases below) -- profile must be a string when present, profile_reason is
// required and non-empty whenever profile is set, and profile+model on the
// SAME command is rejected with store.ts's own exclusivity message (reused,
// not re-derived, per the brief's own instruction). The existence/retired
// check (needs the board's activeProfiles) and the IN_PROGRESS/REVIEW lock
// (update_ticket only) are semantic (phase 2) -- see validateSemantics.
function validateProfileShape(command: Record<string, unknown>, prefix: string): string[] {
  const errors: string[] = [];
  if (command.profile !== undefined && typeof command.profile !== 'string') {
    errors.push(`${prefix}.profile must be a string when present`);
  }
  if (command.profile !== undefined && (typeof command.profile_reason !== 'string' || command.profile_reason.length === 0)) {
    errors.push(`${prefix}.profile_reason must be a non-empty string whenever profile is set`);
  }
  // Second reviewer's Low 8: the pairing runs BOTH ways -- a reason with no
  // profile to justify is meaningless, and would otherwise sit persisted on
  // a profile-less ticket (store.ts's createTicket/updateTicketFields write
  // whatever profileReason they are given, whether or not profile is also
  // set on that same call).
  if (command.profile === undefined && command.profile_reason !== undefined) {
    errors.push(`${prefix}.profile_reason must not be set without profile`);
  }
  if (command.profile !== undefined && command.model !== undefined) {
    errors.push(`${prefix}: ${PROFILE_AND_MODEL_EXCLUSIVE_MESSAGE}`);
  }
  return errors;
}

// Phase 1: structural. Validates each command's own shape against its own
// variant of the schema -- independent of the board, independent of every
// OTHER command in the proposal. Returns every error found (not just the
// first), same exhaustive style as resultContract.ts's validateWorkerResult,
// so a Manager retrying after a malformed-proposal failure sees everything
// wrong in one pass rather than fixing one field at a time.
function validateCommandShape(command: unknown, index: number): string[] {
  const errors: string[] = [];
  const prefix = `commands[${index}]`;

  if (!isPlainObject(command)) {
    return [`${prefix} must be an object`];
  }

  if (typeof command.type !== 'string' || !COMMAND_TYPES.has(command.type as ManagerCommand['type'])) {
    return [
      `${prefix}.type must be one of ${[...COMMAND_TYPES].join(', ')}, got: ${String(command.type)}`,
    ];
  }

  switch (command.type as ManagerCommand['type']) {
    case 'create_ticket': {
      if (typeof command.title !== 'string' || command.title.length === 0) {
        errors.push(`${prefix}.title must be a non-empty string`);
      }
      if (typeof command.description !== 'string') {
        errors.push(`${prefix}.description must be a string`);
      }
      if (!isStringArray(command.acceptance_criteria)) {
        errors.push(`${prefix}.acceptance_criteria must be an array of strings`);
      }
      if (command.depends_on !== undefined && !isStringArray(command.depends_on)) {
        errors.push(`${prefix}.depends_on must be an array of strings when present`);
      }
      // Batch 13 ruling 1a: "agents do not decide where work lives" -- a
      // proposal that sets workspace_type at all is rejected, not merely
      // validated against the enum the way it used to be. Checked here
      // (structural) rather than only omitting the field from the type,
      // since a raw untyped payload could still smuggle the key in --
      // same defensive pattern as "never status" on update_ticket below.
      if (command.workspace_type !== undefined) {
        errors.push(
          `${prefix}.workspace_type must not be set -- work tickets always run in the project's one directory; use \`ticket add --workspace NONE\` for the rare owner-requested exception`
        );
      }
      if (command.model !== undefined && typeof command.model !== 'string') {
        errors.push(`${prefix}.model must be a string when present`);
      }
      if (command.model !== undefined && (typeof command.model_reason !== 'string' || command.model_reason.length === 0)) {
        errors.push(`${prefix}.model_reason must be a non-empty string whenever model is set`);
      }
      errors.push(...validateProfileShape(command, prefix));
      if (command.max_budget_usd !== undefined) {
        if (typeof command.max_budget_usd !== 'number') {
          errors.push(`${prefix}.max_budget_usd must be a number when present`);
        } else if (command.max_budget_usd < MIN_BUDGET_USD) {
          errors.push(`${prefix}.max_budget_usd must be at least $${MIN_BUDGET_USD.toFixed(2)}, got $${command.max_budget_usd.toFixed(2)}`);
        }
      }
      if (command.expected_artifacts !== undefined) {
        errors.push(...validateExpectedArtifacts(command.expected_artifacts, prefix));
      }
      break;
    }
    case 'add_dependency': {
      if (typeof command.ticket_id !== 'string' || command.ticket_id.length === 0) {
        errors.push(`${prefix}.ticket_id must be a non-empty string`);
      }
      if (typeof command.depends_on_ticket_id !== 'string' || command.depends_on_ticket_id.length === 0) {
        errors.push(`${prefix}.depends_on_ticket_id must be a non-empty string`);
      }
      break;
    }
    case 'change_priority': {
      if (typeof command.ticket_id !== 'string' || command.ticket_id.length === 0) {
        errors.push(`${prefix}.ticket_id must be a non-empty string`);
      }
      if (typeof command.priority !== 'number' || !Number.isFinite(command.priority)) {
        errors.push(`${prefix}.priority must be a finite number`);
      }
      break;
    }
    case 'request_user_decision': {
      if (typeof command.question !== 'string' || command.question.length === 0) {
        errors.push(`${prefix}.question must be a non-empty string`);
      }
      if (typeof command.context !== 'string') {
        errors.push(`${prefix}.context must be a string`);
      }
      break;
    }
    case 'update_scope': {
      if (typeof command.content !== 'string') {
        errors.push(`${prefix}.content must be a string`);
      }
      break;
    }
    case 'cancel_ticket': {
      if (typeof command.ticket_id !== 'string' || command.ticket_id.length === 0) {
        errors.push(`${prefix}.ticket_id must be a non-empty string`);
      }
      break;
    }
    case 'update_ticket': {
      if (typeof command.ticket_id !== 'string' || command.ticket_id.length === 0) {
        errors.push(`${prefix}.ticket_id must be a non-empty string`);
      }
      if (command.title !== undefined && typeof command.title !== 'string') {
        errors.push(`${prefix}.title must be a string when present`);
      }
      if (command.description !== undefined && typeof command.description !== 'string') {
        errors.push(`${prefix}.description must be a string when present`);
      }
      if (command.acceptance_criteria !== undefined && !isStringArray(command.acceptance_criteria)) {
        errors.push(`${prefix}.acceptance_criteria must be an array of strings when present`);
      }
      if (command.model !== undefined && typeof command.model !== 'string') {
        errors.push(`${prefix}.model must be a string when present`);
      }
      if (command.model !== undefined && (typeof command.model_reason !== 'string' || command.model_reason.length === 0)) {
        errors.push(`${prefix}.model_reason must be a non-empty string whenever model is set`);
      }
      errors.push(...validateProfileShape(command, prefix));
      if (command.max_budget_usd !== undefined) {
        if (typeof command.max_budget_usd !== 'number') {
          errors.push(`${prefix}.max_budget_usd must be a number when present`);
        } else if (command.max_budget_usd < MIN_BUDGET_USD) {
          errors.push(`${prefix}.max_budget_usd must be at least $${MIN_BUDGET_USD.toFixed(2)}, got $${command.max_budget_usd.toFixed(2)}`);
        }
      }
      // "never status" (this role's brief, verbatim): rejected here even
      // though UpdateTicketCommand's own type has no such field, since a raw
      // proposal (validated as `unknown`) could still smuggle one in --
      // caught explicitly so a hallucinating Manager gets told why, rather
      // than the key silently being ignored at application time.
      if (command.status !== undefined) {
        errors.push(
          `${prefix}.status must not be set -- a ticket's status has exactly one write site and update_ticket may never set it directly`
        );
      }
      // Batch 13 ruling 1a: same rejection as create_ticket above -- never
      // had a typed field for this, but a raw proposal could still smuggle
      // the key in.
      if (command.workspace_type !== undefined) {
        errors.push(
          `${prefix}.workspace_type must not be set -- work tickets always run in the project's one directory; use \`ticket add --workspace NONE\` for the rare owner-requested exception`
        );
      }
      if (command.expected_artifacts !== undefined) {
        errors.push(...validateExpectedArtifacts(command.expected_artifacts, prefix));
      }
      break;
    }
  }

  return errors;
}

// A key namespace for a ticket this proposal is ABOUT to create, distinct
// from any real ticket id (`newId('tkt')` always produces `tkt_<uuid>`,
// never this shape) -- lets the cycle graph below treat "depends on a
// title this same proposal defines" and "depends on an id that already
// exists" as nodes in the same graph without either namespace colliding
// with the other.
function newTicketNodeKey(title: string): string {
  return `proposal-new:${title}`;
}

// Standard three-colour DFS cycle detection (white/gray/black) over a
// directed graph of "depends on" edges (u -> v means u cannot start until v
// is DONE). A back edge (an edge into a GRAY node, i.e. a node still on the
// current DFS stack) is exactly a cycle, including the degenerate one-node
// case of a ticket depending on itself.
function hasCycle(edges: Map<string, Set<string>>): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const nodes = new Set<string>();
  for (const [from, tos] of edges) {
    nodes.add(from);
    for (const to of tos) nodes.add(to);
  }
  for (const n of nodes) color.set(n, WHITE);

  const stack: string[] = [];
  function visit(node: string): boolean {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const c = color.get(next);
      if (c === GRAY) return true;
      if (c === WHITE && visit(next)) return true;
    }
    stack.pop();
    color.set(node, BLACK);
    return false;
  }

  for (const n of nodes) {
    if (color.get(n) === WHITE && visit(n)) return true;
  }
  return false;
}

// Phase 2: semantic, run only once every command's own shape is known good
// (phase 1 passed) -- title uniqueness, dependency resolution, the
// manager/work no-cross-dependency rule, and cycle rejection, all against
// the real board plus this proposal's own internal references.
function validateSemantics(commands: ManagerCommand[], board: ProposalBoard): string[] {
  const errors: string[] = [];

  const existingById = new Map(board.tickets.map((t) => [t.id, t]));
  const existingTitles = new Set(board.tickets.map((t) => t.title));
  const createCommands = commands.filter((c): c is CreateTicketCommand => c.type === 'create_ticket');

  if (!board.hasScopePath && commands.some((c) => c.type === 'update_scope')) {
    errors.push(
      'update_scope cannot be applied: this project has no scope_path set yet (see project create --dir / project set --dir)'
    );
  }

  // Title uniqueness: within the proposal, and against the existing board.
  const seenNewTitles = new Set<string>();
  for (const c of createCommands) {
    if (existingTitles.has(c.title)) {
      errors.push(`create_ticket title "${c.title}" already exists on the board -- titles must be unique within a project`);
    } else if (seenNewTitles.has(c.title)) {
      errors.push(`create_ticket title "${c.title}" is declared more than once in this proposal`);
    }
    seenNewTitles.add(c.title);
    // Batch 19 mini-phase 2A review fix (High 2 / Low 5): resolved through
    // the board's OWN lookup -- literally store.ts's getWorkerProfileByName
    // (see managerApply.ts's buildProposalBoard), never a second, hand-rolled
    // folding rule -- so this can never disagree with what
    // managerApply.ts's createTicket will actually do with the SAME name at
    // apply time. Name only, per ruling 37's grammar: `resolveActiveProfileByName`
    // takes no id shortcut, so a `prof_...` id is refused the same as any
    // other unrecognized string.
    if (c.profile !== undefined && !board.resolveActiveProfileByName(c.profile)) {
      errors.push(`create_ticket "${c.title}".profile "${c.profile}" is not a known, active worker profile, by name`);
    }
  }

  // Dependency graph: existing board edges, plus every edge this proposal
  // would add. Built regardless of whether earlier checks already found an
  // error, so a single validateProposal call surfaces everything wrong at
  // once (see validateCommandShape's own doc comment for the same reasoning).
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string): void => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  };
  for (const dep of board.dependencies) {
    addEdge(dep.ticketId, dep.dependsOnTicketId);
  }

  // create_ticket.depends_on: each ref resolves to an existing ticket id
  // first (existing tickets are only ever referenced by id), else to
  // another create_ticket's title within this SAME proposal. Unresolvable
  // either way is a dangling reference, not a cycle -- reported as such.
  for (const c of createCommands) {
    const fromKey = newTicketNodeKey(c.title);
    for (const ref of c.depends_on ?? []) {
      const existing = existingById.get(ref);
      if (existing) {
        if (existing.kind === 'manager') {
          errors.push(
            `create_ticket "${c.title}" depends_on "${ref}", which is a manager ticket -- manager tickets and work tickets may never depend on each other`
          );
          continue;
        }
        addEdge(fromKey, ref);
        continue;
      }
      if (seenNewTitles.has(ref) && ref !== c.title) {
        addEdge(fromKey, newTicketNodeKey(ref));
        continue;
      }
      if (ref === c.title) {
        // A ticket cannot depend on itself by its own not-yet-assigned
        // title; treated as a direct self-cycle rather than "not found",
        // since it unambiguously resolves to the same node.
        addEdge(fromKey, fromKey);
        continue;
      }
      errors.push(
        `create_ticket "${c.title}" depends_on "${ref}", which is neither an existing ticket id nor another create_ticket's title in this proposal`
      );
    }
  }

  // add_dependency / change_priority: both fields (or the one field, for
  // change_priority) must resolve to an EXISTING ticket -- never a title,
  // never a ticket this same proposal is only about to create (see
  // AddDependencyCommand's doc comment).
  for (const c of commands) {
    if (c.type === 'add_dependency') {
      const ticket = existingById.get(c.ticket_id);
      const dependsOn = existingById.get(c.depends_on_ticket_id);
      if (!ticket) errors.push(`add_dependency.ticket_id "${c.ticket_id}" is not an existing ticket on this board`);
      if (!dependsOn) errors.push(`add_dependency.depends_on_ticket_id "${c.depends_on_ticket_id}" is not an existing ticket on this board`);
      if (ticket && dependsOn) {
        if (ticket.kind === 'manager' || dependsOn.kind === 'manager') {
          errors.push(
            `add_dependency between "${c.ticket_id}" and "${c.depends_on_ticket_id}" involves a manager ticket -- manager tickets and work tickets may never depend on each other`
          );
        } else {
          addEdge(c.ticket_id, c.depends_on_ticket_id);
        }
      }
    }
    if (c.type === 'change_priority' && !existingById.has(c.ticket_id)) {
      errors.push(`change_priority.ticket_id "${c.ticket_id}" is not an existing ticket on this board`);
    }

    // Batch 11 item 4: cancel_ticket/update_ticket both resolve ticket_id
    // against the EXISTING board only (same rule as add_dependency/
    // change_priority above -- never a title, never a same-proposal
    // create_ticket), may never target a manager ticket (this file's own
    // extension of the existing manager/work security boundary), and
    // cancel_ticket additionally requires the ticket's CURRENT status to be
    // one the `cancel` transition actually accepts -- checked here so an
    // un-cancellable target is a clean validation error, not an
    // InvalidTransitionError escaping the application transaction.
    if (c.type === 'cancel_ticket') {
      const ticket = existingById.get(c.ticket_id);
      if (!ticket) {
        errors.push(`cancel_ticket.ticket_id "${c.ticket_id}" is not an existing ticket on this board`);
      } else if (ticket.kind === 'manager') {
        errors.push(`cancel_ticket.ticket_id "${c.ticket_id}" is a manager ticket -- cancel_ticket may never target a manager ticket`);
      } else if (!CANCELLABLE_STATUSES.has(ticket.status)) {
        errors.push(
          `cancel_ticket.ticket_id "${c.ticket_id}" is ${ticket.status}, which cannot be cancelled (only OPEN, READY, IN_PROGRESS and REVIEW can)`
        );
      }
    }
    if (c.type === 'update_ticket') {
      const ticket = existingById.get(c.ticket_id);
      if (!ticket) {
        errors.push(`update_ticket.ticket_id "${c.ticket_id}" is not an existing ticket on this board`);
      } else if (ticket.kind === 'manager') {
        errors.push(`update_ticket.ticket_id "${c.ticket_id}" is a manager ticket -- update_ticket may never target a manager ticket`);
      } else {
        // Batch 19 mini-phase 2A review fix (High 1): validated against the
        // RESULTING row -- this ticket's CURRENT model/profileId, overridden
        // by whichever of the two THIS command actually sets -- not just
        // whether the command sets both in the same breath. A command that
        // adds "profile" to a ticket that already carries a bare "model"
        // (or "model" to a ticket that already carries a profile) is
        // rejected here, before application, with the SAME one sentence
        // store.ts's own assertProfileModelExclusive throws -- catching it
        // here is what stops that throw from ever reaching
        // applyManagerProposal's transaction (see this file's own header
        // comment: a clean validation error, not an unhandled throw, is the
        // whole point of this module).
        if (c.profile !== undefined || c.model !== undefined) {
          const resultingHasModel = (c.model !== undefined ? c.model : ticket.model) != null;
          const resultingHasProfile = (c.profile !== undefined ? c.profile : ticket.profileId) != null;
          if (resultingHasModel && resultingHasProfile) {
            errors.push(`update_ticket.ticket_id "${c.ticket_id}": ${PROFILE_AND_MODEL_EXCLUSIVE_MESSAGE}`);
          }
        }
        // The other two profile-specific refusals: an unknown/retired name
        // (same lookup create_ticket's own loop above runs) and changing the
        // profile of a ticket a run may already be using.
        if (c.profile !== undefined) {
          if (!board.resolveActiveProfileByName(c.profile)) {
            errors.push(`update_ticket.ticket_id "${c.ticket_id}".profile "${c.profile}" is not a known, active worker profile, by name`);
          }
          if (PROFILE_LOCKED_STATUSES.has(ticket.status)) {
            errors.push(
              `update_ticket.ticket_id "${c.ticket_id}" is ${ticket.status} -- its profile cannot be changed while a run may already be using it`
            );
          }
        }
      }
    }
  }

  if (errors.length === 0 && hasCycle(edges)) {
    errors.push(
      'this proposal would introduce a dependency cycle -- rejected whole, since a cyclic dependency would deadlock the board permanently'
    );
  }

  return errors;
}

// Validates a Manager run's raw proposal.json against the schema above and
// the current board, per batch-9-spec.md section 2: "Every command is
// validated against the schema and the current board before any is
// applied; one invalid command rejects the whole proposal as a malformed
// result." Caller (scheduler.ts's post-success step) treats an invalid
// result the same way an ordinary malformed WorkerResult already is:
// retryable, reaching the inbox on exhaustion with these errors attached.
export function validateProposal(raw: unknown, board: ProposalBoard): ProposalValidationResult {
  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['proposal must be a JSON object'] };
  }
  if (typeof raw.rationale !== 'string') {
    return { valid: false, errors: ['proposal.rationale must be a string'] };
  }
  if (!Array.isArray(raw.commands)) {
    return { valid: false, errors: ['proposal.commands must be an array'] };
  }
  if (raw.commands.length > MAX_COMMANDS) {
    return { valid: false, errors: [`proposal.commands has ${raw.commands.length} entries, more than the cap of ${MAX_COMMANDS}`] };
  }

  const shapeErrors = raw.commands.flatMap((c, i) => validateCommandShape(c, i));
  if (shapeErrors.length > 0) {
    return { valid: false, errors: shapeErrors };
  }

  const commands = raw.commands as ManagerCommand[];
  const createCount = commands.filter((c) => c.type === 'create_ticket').length;
  if (createCount > MAX_CREATE_TICKET_COMMANDS) {
    return {
      valid: false,
      errors: [`proposal has ${createCount} create_ticket commands, more than the cap of ${MAX_CREATE_TICKET_COMMANDS}`],
    };
  }

  const semanticErrors = validateSemantics(commands, board);
  if (semanticErrors.length > 0) {
    return { valid: false, errors: semanticErrors };
  }

  return { valid: true, data: { commands, rationale: raw.rationale } };
}
