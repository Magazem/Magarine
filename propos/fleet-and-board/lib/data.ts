// All content below is taken verbatim from the three Magarine source screens.
// This file only holds the machine-shaped data (fleet trees, board rows,
// activity logs); the prose blocks (inbox reasons, conversation, scope) live
// in the screens themselves because they carry inline markup.

export type Status =
  | 'blocked'
  | 'failed'
  | 'in_progress'
  | 'review'
  | 'ready'
  | 'open'
  | 'done'
  | 'cancelled'

export interface FleetItem {
  status: Status
  label: string
  mgr?: boolean
  title: string
  shortid: string
  current?: boolean
}

export interface BoardNote {
  summary: string
  body: string
  mono?: string
  tail?: string
}

export interface BoardRow {
  title: string
  mgr?: boolean
  id: string
  status: Status
  statusLabel: string
  attempts: string
  cost: string
  costSpent?: boolean
  liveEstimate?: boolean
  artifacts?: string[]
  note?: BoardNote
  blockedBy?: string
  action?: string
  live?: boolean
}

export interface LogRow {
  t: string
  kind: string
  cls?: 'bad' | 'need' | 'good'
  ticket: string
}

/* ============================================================ screen 1 === */
export const boardFleet: FleetItem[] = [
  { status: 'blocked', label: 'Blocked', title: 'Needs a decision from the owner', shortid: 'tkt_ed46cad3' },
  { status: 'failed', label: 'Failed', mgr: true, title: '# Scope: a small reference on SQLite journal modes', shortid: 'tkt_98f609d3' },
  { status: 'in_progress', label: 'In progress', title: 'Write wal.md covering write-ahead logging', shortid: 'tkt_9ef76af6' },
  { status: 'ready', label: 'Ready', mgr: true, title: 'Manager: discuss: Typed from a real browser: please keep it short.', shortid: 'tkt_94c9ca9e' },
  { status: 'done', label: 'Done', title: 'Write the introduction section', shortid: 'tkt_72f34caf' },
]

export const boardRows: BoardRow[] = [
  {
    title: 'Needs a decision from the owner',
    id: 'tkt_ed46cad3-6810-4de4-a54e-7f913acdd19f',
    status: 'blocked', statusLabel: 'Blocked',
    attempts: '0/3', cost: '$0.00',
    action: 'Answer',
  },
  {
    title: '# Scope: a small reference on SQLite journal modes', mgr: true,
    id: 'tkt_98f609d3-c704-4936-a96b-8591536a3990',
    status: 'failed', statusLabel: 'Failed',
    attempts: '3/3', cost: '$0.25', costSpent: true,
    note: {
      summary: 'why it failed',
      body: 'proposal must be a JSON object — ',
      mono: 'magarine retry --ticket tkt_98f609d3-c704-4936-a96b-8591536a3990',
      tail: ', once the reason above is addressed',
    },
    action: 'Retry',
  },
  {
    title: 'Write wal.md covering write-ahead logging',
    id: 'tkt_9ef76af6-5d02-43c2-96b6-34ee19aa8b2d',
    status: 'in_progress', statusLabel: 'In progress',
    attempts: '1/3', cost: '$0.12', liveEstimate: true, live: true,
    note: {
      summary: 'model claude-haiku-4-5-20251001',
      body: 'Mechanical writing task with a fully fixed spec — no design judgment required.',
    },
    action: 'Cancel',
  },
  {
    title: 'Manager: discuss: Typed from a real browser: please keep it short.', mgr: true,
    id: 'tkt_94c9ca9e-4ee6-4e5f-a087-d738ea645e46',
    status: 'ready', statusLabel: 'Ready',
    attempts: '2/3', cost: '$0.00',
    blockedBy: 'tkt_9ef76af6-5d02-43c2-96b6-34ee19aa8b2d',
  },
  {
    title: 'Write the introduction section',
    id: 'tkt_72f34caf-f94c-489f-ab8a-4a4c30ee24af',
    status: 'done', statusLabel: 'Done',
    attempts: '0/3', cost: '$0.00',
    artifacts: ['introduction.md', 'index.md'],
  },
]

export const boardLog: LogRow[] = [
  { t: '06:44:21.126', kind: 'worker_needs_user_decision', cls: 'need', ticket: 'tkt_ed46cad3' },
  { t: '06:44:21.117', kind: 'run_started', ticket: 'tkt_ed46cad3' },
  { t: '06:44:21.108', kind: 'worker_done', cls: 'good', ticket: 'tkt_72f34caf' },
  { t: '06:44:21.097', kind: 'run_started', ticket: 'tkt_72f34caf' },
  { t: '06:44:21.089', kind: 'dependencies_resolved', ticket: 'tkt_ed46cad3' },
  { t: '06:44:21.074', kind: 'dependencies_resolved', ticket: 'tkt_72f34caf' },
  { t: '06:44:14.760', kind: 'worker_failed_retryable', cls: 'bad', ticket: 'tkt_94c9ca9e' },
  { t: '06:44:14.749', kind: 'run_started', ticket: 'tkt_94c9ca9e' },
  { t: '06:44:11.732', kind: 'discuss', ticket: 'proj_396d8ad0' },
  { t: '06:43:40.645', kind: 'worker_failed_final', cls: 'bad', ticket: 'tkt_98f609d3' },
  { t: '06:43:23.756', kind: 'scope_updated', ticket: 'proj_393c405c' },
]

/* ============================================================ screen 2 === */
export const needsFleet: FleetItem[] = [
  { status: 'blocked', label: 'Blocked', title: 'Needs a decision from the owner', shortid: 'tkt_ed46cad3', current: true },
  { status: 'failed', label: 'Failed', mgr: true, title: '# Scope: a small reference on SQLite journal modes', shortid: 'tkt_98f609d3' },
  { status: 'review', label: 'Review', title: 'Write wal.md covering write-ahead logging', shortid: 'tkt_9ef76af6' },
  { status: 'open', label: 'Open', title: 'Write index.md linking all three modes', shortid: 'tkt_1b70e2a4' },
  { status: 'done', label: 'Done', title: 'Write the introduction section', shortid: 'tkt_72f34caf' },
  { status: 'cancelled', label: 'Cancelled', title: 'Write memory.md covering the in-memory journal', shortid: 'tkt_5c0a91de' },
]

export const needsBoardRows: BoardRow[] = [
  {
    title: 'Needs a decision from the owner',
    id: 'tkt_ed46cad3-6810-4de4-a54e-7f913acdd19f',
    status: 'blocked', statusLabel: 'Blocked',
    attempts: '0/3', cost: '$0.00', action: 'Answer',
  },
  {
    title: '# Scope: a small reference on SQLite journal modes', mgr: true,
    id: 'tkt_98f609d3-c704-4936-a96b-8591536a3990',
    status: 'failed', statusLabel: 'Failed',
    attempts: '3/3', cost: '$4.85', costSpent: true,
    note: { summary: 'why it failed', body: 'proposal must be a JSON object' },
    action: 'Retry',
  },
  {
    title: 'Write wal.md covering write-ahead logging',
    id: 'tkt_9ef76af6-5d02-43c2-96b6-34ee19aa8b2d',
    status: 'review', statusLabel: 'Review',
    attempts: '1/3', cost: '$3.90', costSpent: true,
    artifacts: ['wal.md'], action: 'Approve',
  },
  {
    title: 'Write index.md linking all three modes',
    id: 'tkt_1b70e2a4-3fd1-49b7-b2c9-0e42a4f7c188',
    status: 'open', statusLabel: 'Open',
    attempts: '0/3', cost: '$0.00',
    blockedBy: 'tkt_ed46cad3-6810-4de4-a54e-7f913acdd19f',
  },
  {
    title: 'Write the introduction section',
    id: 'tkt_72f34caf-f94c-489f-ab8a-4a4c30ee24af',
    status: 'done', statusLabel: 'Done',
    attempts: '0/3', cost: '$2.13', costSpent: true,
    artifacts: ['introduction.md'],
  },
  {
    title: 'Write memory.md covering the in-memory journal',
    id: 'tkt_5c0a91de-77b4-4a11-9f3e-2c8d6b0a41e7',
    status: 'cancelled', statusLabel: 'Cancelled',
    attempts: '1/3', cost: '$1.12', costSpent: true,
  },
]

export const needsLog: LogRow[] = [
  { t: '06:44:30.902', kind: 'project_spend_cap_reached', cls: 'bad', ticket: 'proj_393c405c' },
  { t: '06:44:21.126', kind: 'worker_needs_user_decision', cls: 'need', ticket: 'tkt_ed46cad3' },
  { t: '06:44:21.108', kind: 'worker_done', cls: 'good', ticket: 'tkt_72f34caf' },
  { t: '06:44:21.097', kind: 'run_started', ticket: 'tkt_72f34caf' },
  { t: '06:44:21.089', kind: 'dependencies_resolved', ticket: 'tkt_ed46cad3' },
  { t: '06:44:18.340', kind: 'worker_needs_review', cls: 'need', ticket: 'tkt_9ef76af6' },
  { t: '06:44:17.118', kind: 'run_started', ticket: 'tkt_9ef76af6' },
  { t: '06:44:12.004', kind: 'ticket_cancelled', ticket: 'tkt_5c0a91de' },
  { t: '06:43:40.645', kind: 'worker_failed_final', cls: 'bad', ticket: 'tkt_98f609d3' },
  { t: '06:43:38.627', kind: 'worker_failed_retryable', cls: 'bad', ticket: 'tkt_98f609d3' },
  { t: '06:43:23.756', kind: 'scope_updated', ticket: 'proj_393c405c' },
]

/* ============================================================ screen 3 === */
export const scopeFleet: FleetItem[] = [
  { status: 'blocked', label: 'Blocked', title: 'Needs a decision from the owner', shortid: 'tkt_ed46cad3' },
  { status: 'in_progress', label: 'In progress', title: 'Write wal.md covering write-ahead logging', shortid: 'tkt_9ef76af6' },
  { status: 'done', label: 'Done', title: 'Write the introduction section', shortid: 'tkt_72f34caf' },
]

export const scopeLog: LogRow[] = [
  { t: '17:56:44.301', kind: 'worker_needs_user_decision', cls: 'need', ticket: 'tkt_ed46cad3' },
  { t: '17:56:19.058', kind: 'manager_assessment', ticket: 'proj_393c405c' },
  { t: '17:56:11.732', kind: 'discuss', ticket: 'proj_393c405c' },
  { t: '17:55:41.220', kind: 'manager_reply', ticket: 'proj_393c405c' },
  { t: '17:55:34.910', kind: 'discuss', ticket: 'proj_393c405c' },
  { t: '17:55:23.756', kind: 'scope_updated', ticket: 'proj_393c405c' },
]

export const scopeText = `# Scope: a small reference on SQLite journal modes

Write delete.md, wal.md and memory.md, one per mode, then index.md last
linking all three.

## Audience

Someone who has used SQLite through a library, has never set
journal_mode deliberately, and has just been told by someone that they
should be using WAL. They do not need the file format; they need to know
what changes for them.

## Per-mode file

Each of the three mode files covers, in this order:

1. What the mode actually does on COMMIT, in two or three sentences.
2. What it costs -- fsyncs, extra files on disk, reader/writer blocking.
3. When it is the right choice, stated as a situation rather than a rule.
4. The one failure mode people hit with it in practice.

Keep each file under roughly 400 words. Prose, not bullet soup: the
bullets above are the checklist for writing it, not the shape of the
output.

## index.md

Written last, once the other three exist. One paragraph of orientation,
then a short table comparing the three on durability, concurrency and
disk cost, then links. Do not summarise the three files -- link them.

## Constraints

- No benchmarks. Any number would be made up.
- Do not recommend WAL unconditionally; it is wrong over a network
  filesystem, and that belongs in wal.md's failure mode section.
- British or American spelling, but the same one throughout.`

/* The worker's rotating status line while a ticket is genuinely running. */
export const workerPhrases = [
  'reading SCOPE.md',
  'mapping journal modes',
  'drafting wal.md',
  'checking word count',
  'verifying claims',
]
