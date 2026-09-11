# Cross-Platform Agent Orchestration System

## Technical Architecture and Weekend MVP Plan

## Recommendation

Build a small, independent orchestration daemon around AionUI:

> AionUI executes agents. The orchestrator owns tickets, dependencies, lifecycle, persistence, notifications, and cost control.

Do not make AionUI Team Mode or Beadhive the system of record. Both provide useful primitives, but neither exactly matches the full requirement set.

AionUI currently exposes team creation, agent/session management, conversation messaging, and WebSocket status events. Its task board and mailbox are primarily internal MCP capabilities rather than external HTTP APIs. Its documentation also lists wake-up, crash-recovery, and message-loss edge cases.

Beadhive/Beads is the strongest reference for dependency-aware work, atomic claims, gates, and worktree-based execution. However, Beadhive is primarily a coding workflow built around `bd` and Git, with no documented AionUI integration.

Scape validates the manager-plus-isolated-workers pattern, especially fresh worktrees, periodic orchestration, and structured logs, but it is coding-focused and tied to its own session platform.

## Proposed architecture

```text
                         User
                          │
                 Inbox / Board / Activity
                          │
                   Local HTTP API
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
  Orchestrator Core                   Manager Context
        │                            Submanager Context
        │                                   │
 ┌──────┼──────────┬───────────┐           │
 │      │          │           │           │
State  Scheduler  Policy   Adapter Registry
DB     + Lifecycle Engine        │
 │                              │
 │                 ┌────────────┼────────────┐
 │                 │            │            │
 │              AionUI       CLI/ACP       Mock
 │              Adapter      Adapter       Adapter
 │                 │
 │          Fresh worker session
 │                 │
 └────────── Events / Results / Artifacts
```

### Orchestrator daemon

Use a cross-platform TypeScript/Node.js service running on Windows and Linux.

- Local HTTP API
- SQLite database
- Scheduler
- State-machine enforcement
- Event log
- Notification filtering
- Agent adapter registry
- Workspace manager
- Optional Git worktree manager

### Web UI

Use a React/Vite application served locally. For the weekend MVP, keep it browser-based; package it as Tauri or integrate it into AionUI later.

The UI should contain:

- Board
- Inbox
- Activity timeline
- Ticket detail
- Worker/run detail
- Project settings
- Cost and concurrency controls

### Manager and Submanager

Manager and Submanager sessions remain long-lived, but they are not operational controllers.

They can:

- maintain project strategy
- propose tickets
- update milestones
- explain decisions
- request clarification
- replan after meaningful failures

They should submit typed commands such as:

```text
create_ticket
add_dependency
change_priority
request_user_decision
update_project_brief
```

The orchestrator validates and applies those commands. The Manager receives meaningful state changes, not every worker message.

## Ticket lifecycle

```text
OPEN
  │ requirements complete and dependencies resolved
  ▼
READY
  │ scheduler claims atomically
  ▼
IN_PROGRESS
  ├── worker succeeds ───────────────► REVIEW
  ├── worker passes auto-checks ─────► DONE
  ├── retryable failure ─────────────► READY
  ├── worker asks internal question ─► IN_PROGRESS
  └── user decision required ────────► BLOCKED
```

Additional operational states:

- `FAILED`: retries exhausted
- `CANCELLED`
- `REASSIGNED`
- `BLOCKED`

A ticket should not become `DONE` merely because an agent says “finished.” It needs either a successful result contract and automated checks, or explicit human review.

## Suggested data model

Use SQLite as the canonical MVP state store.

### `projects`

```text
id
name
description
strategic_context
manager_session_ref
submanager_session_ref
default_adapter
max_parallel_workers
created_at
updated_at
```

### `tickets`

```text
id
project_id
title
description
acceptance_criteria_json
status
priority
assignee
attempt_count
max_attempts
workspace_type
workspace_ref
result_json
created_at
updated_at
```

### `ticket_dependencies`

```text
ticket_id
depends_on_ticket_id
dependency_type   -- blocks, related, parent
```

### `runs`

One ticket may have multiple runs because of retries or reassignment.

```text
id
ticket_id
attempt
adapter
worker_session_ref
workspace_ref
status
started_at
finished_at
failure_class
```

### `events`

Append-only operational history.

```text
sequence
project_id
event_type
entity_type
entity_id
payload_json
visibility
created_at
```

`visibility` should be one of:

```text
internal
activity
inbox
urgent
```

### `messages`

Structured internal communication.

```text
id
project_id
ticket_id
sender
recipient
message_type
payload_json
requires_user
acknowledged_at
created_at
```

### `artifacts`

```text
id
ticket_id
kind
path_or_uri
description
checksum
created_at
```

The key principle is:

> Chat transcripts are evidence attached to a run. They are not project state.

## Agent adapter abstraction

The orchestrator should not know whether a worker is AionUI, Claude Code, Codex, OpenCode, or another system.

```ts
interface AgentAdapter {
  id: string;

  capabilities(): Promise<{
    supportsFiles: boolean;
    supportsShell: boolean;
    supportsStreaming: boolean;
    supportsResume: boolean;
  }>;

  startWorker(input: {
    ticket: TicketEnvelope;
    workspace?: Workspace;
    systemPolicy: string;
  }): Promise<WorkerHandle>;

  send(handle: WorkerHandle, message: string): Promise<void>;

  observe(
    handle: WorkerHandle,
    onEvent: (event: WorkerEvent) => void
  ): Promise<() => void>;

  stop(handle: WorkerHandle): Promise<void>;

  destroy(handle: WorkerHandle): Promise<void>;
}
```

The worker receives only:

```text
Project brief
Relevant decisions
Ticket description
Acceptance criteria
Dependencies already completed
Allowed tools
Workspace location
Expected output format
```

It does not receive the Manager’s entire conversation.

### Worker result contract

Require every worker to produce a structured result:

```json
{
  "status": "ready_for_review",
  "summary": "Implemented the requested change.",
  "artifacts": [
    {
      "kind": "file",
      "path": "src/example.ts"
    }
  ],
  "checks": [
    {
      "name": "unit tests",
      "status": "passed"
    }
  ],
  "blockers": [],
  "questions": []
}
```

For coding tasks, the worker writes this to `.orchestrator/result.json`. For non-file tasks, the adapter can collect the final structured message directly.

## AionUI integration path

The first adapter should target AionUI.

Current public AionCore documentation shows:

- `POST /api/teams` to create a team
- `POST /api/teams/{id}/session` to start it
- `TeamAgentResponse.conversation_id` as the messaging key
- `POST /api/conversations/{conversation_id}/messages` to send work
- WebSocket events for agent status
- team task/mailbox operations exposed primarily through MCP, not HTTP

For the MVP:

1. Create one isolated AionUI team/agent per ticket.
2. Start the team session.
3. Send one compact kickoff prompt.
4. Monitor status through WebSocket where available.
5. Read the final conversation result or `.orchestrator/result.json`.
6. Move the ticket to `REVIEW`, `DONE`, `READY`, or `BLOCKED`.
7. Stop/delete the worker session after completion.

Do not use AionUI’s internal mailbox as the authoritative communication layer. Use the orchestrator’s own structured mailbox and event store.

If AionUI’s direct conversation-creation API becomes stable and discoverable, add it later. For the first adapter, use documented team endpoints rather than private SQLite tables or undocumented internals.

## Notification policy

The orchestrator should be silent by default.

| Event | Internal only | Activity | Inbox | Push/email |
|---|---:|---:|---:|---:|
| Worker started | Yes | Optional | No | No |
| Worker progress | Yes | Collapsed | No | No |
| Worker retry | Yes | Yes | No | No |
| Worker completed | No | Yes | If review needed | No |
| Internal worker question | Yes | Yes | No | No |
| User decision required | No | Yes | Yes | Optional |
| Permission/credential required | No | Yes | Yes | Optional |
| Retry limit exhausted | No | Yes | Yes | Optional |
| Dependency completed | No | Yes | No | No |
| Project completed | No | Yes | Yes | Optional |

The UI should say:

> Ticket T-104 needs your review.

It should not automatically expose the entire chain of intermediate conversations. That detail remains available under Activity if the user opens it.

### Cost-control rules

- No LLM call for dependency checks.
- No LLM call for retries.
- No LLM call for status transitions.
- No LLM call to summarize every event.
- No automatic Manager response to every worker message.
- Manager is called only for new mission decomposition, ambiguous blockers, material plan changes, explicit user requests, or scheduled strategic reviews.
- Workers receive fixed-size context envelopes.
- Completed worker sessions are destroyed or archived.
- Progress is represented by structured events, not generated prose.

## Beads/Beadhive integration strategy

Treat Beads as an optional backend, not the MVP foundation.

A future `TrackerAdapter` could map:

```text
your ticket     ↔ Beads issue
dependency      ↔ bd dependency
READY           ↔ bd ready
claim           ↔ bd update --claim
DONE            ↔ bd close
review gate     ↔ bd gate
```

Beads is attractive because it already provides dependency graphs, atomic claims, machine-readable output, persistent memory, and ready-work calculation.

However:

- it is strongly optimized for coding workflows
- its state is tied to project/repository concepts
- worktree state introduces merge and synchronization complexity
- no public AionUI integration was found
- Beadhive’s documented process assumes Git worktrees and its own seats/harnesses

Recommended order:

1. Own SQLite ticket model.
2. Add import/export compatibility with Beads.
3. Add a Beads backend for coding-heavy projects.
4. Keep arbitrary non-code projects on the native SQLite backend.

## Workspaces

Support three workspace modes:

```text
NONE
  For planning, research, writing, analysis, and external-tool work.

DIRECTORY
  A dedicated project directory for file-based work.

GIT_WORKTREE
  A temporary branch/worktree for coding tasks.
```

For Git worktrees:

```text
project/
  .orchestrator/
  worktrees/
    T-101/
    T-102/
```

Each worker gets one worktree and one branch. The orchestrator owns creation and cleanup.

Do not attempt automatic merging in the weekend MVP. A worker finishes, the ticket enters `REVIEW`, and merging remains explicit.

## Weekend MVP

The MVP should prove this loop:

```text
Create project
  → create tickets
  → add dependencies
  → scheduler finds READY tickets
  → spawn isolated AionUI worker
  → worker produces structured result
  → ticket enters REVIEW/DONE
  → user sees one Inbox item only when needed
```

### Must-have

- SQLite persistence
- Ticket CRUD
- Dependency graph
- Atomic ticket claiming
- Scheduler
- Retry/reassignment
- AionUI adapter
- Worker result contract
- Minimal Board
- Minimal Inbox
- Activity log
- Optional directory workspace
- Basic Git worktree support
- Concurrency limit
- Silent notification policy

### Defer

- Full Manager/Submanager automation
- Beads backend
- Email delivery
- Multi-machine workers
- Remote execution
- Automatic merging
- Advanced planning
- Semantic code review
- Plugin marketplace
- Authentication and multi-user collaboration
- Mobile UI
- Production packaging

## Suggested weekend schedule

### Friday evening

- Create repository and TypeScript service.
- Add SQLite schema and migrations.
- Implement ticket state machine.
- Implement a fake worker adapter.
- Test dependency resolution without any LLM.

### Saturday morning

- Implement event log.
- Implement scheduler and atomic claims.
- Implement retries and reassignment.
- Add concurrency limits.
- Add result JSON validation.

### Saturday afternoon

- Implement AionUI adapter.
- Add team creation/session startup.
- Add message dispatch.
- Add status monitoring.
- Add worker cleanup.

### Saturday evening

- Build Board view.
- Build Inbox view.
- Build ticket detail page.
- Add collapsed Activity timeline.

### Sunday morning

- Add directory and Git worktree workspace providers.
- Add blocked-ticket handling.
- Add user decision events.
- Add manual retry/reassign controls.
- Add Manager “propose changes” endpoint, even if the Manager is initially manual.

### Sunday afternoon

Run an end-to-end test with three tickets:

```text
T1: independent task
T2: independent task
T3: depends on T1 and T2
```

Verify that T1 and T2 run in parallel and T3 waits.

Also test:

- worker failure and retry
- worker question routed internally
- user decision appearing in Inbox
- restart recovery
- duplicate event handling
- AionUI unavailable
- malformed worker result

## Prioritized implementation sequence

1. SQLite schema and state transitions.
2. Dependency resolver.
3. Event store.
4. Fake adapter.
5. Scheduler.
6. Worker result protocol.
7. AionUI adapter.
8. Board and Inbox UI.
9. Retry/reassignment.
10. Workspace providers.
11. Restart recovery.
12. Manager/Submanager command interface.
13. Beads backend.
14. Email/push notifications.
15. Packaging.

## Main risks

### AionUI API stability

The documented Team API is usable, but some features are still evolving. Keep the adapter isolated and make the fake adapter a permanent test implementation.

### Completion detection

A final chat message is not a reliable state contract. Prefer `result.json`, with the final message as fallback.

### Worker context leakage

Never pass full Manager or previous-worker transcripts into a new worker. Only pass explicit project and ticket context.

### Concurrent Git changes

Parallel worktrees reduce collisions but do not eliminate merge conflicts. Keep merging outside the MVP.

### Arbitrary project work

Not every worker produces files or commits. Model artifacts as generic records: files, URLs, reports, decisions, datasets, or external references.

### State corruption

Use an append-only event log plus derived current state. Every event should have an idempotency key.

### Notification creep

Enforce the policy in code. Do not let an LLM decide whether something should notify the user.

## Final architectural rule

> Agents may produce work and structured events. Only the orchestrator may change ticket state, and only the notification policy may interrupt the user.

This gives you the useful parts of AionUI, Beads, Beadhive, and Scape without inheriting their assumptions or their chat-driven verbosity.

## References

- [AionCore Team HTTP API](https://github.com/iOfficeAI/AionCore/blob/main/crates/aionui-team/docs/api.md)
- [AionCore Team Architecture](https://github.com/iOfficeAI/AionCore/blob/main/crates/aionui-team/docs/README.md)
- [AionCore Team Internals](https://github.com/iOfficeAI/AionCore/blob/main/crates/aionui-team/docs/internals.md)
- [Beads](https://github.com/steveyegge/beads)
- [Beadhive process](https://beadhive.ai/process/)
- [Beadhive substrate](https://beadhive.ai/beads/)
- [Scape Argus](https://www.scape.sh/docs/argus)
