import test from 'node:test';
import assert from 'node:assert/strict';
import { MANAGER_COMMAND_SCHEMA_DESCRIPTION, MAX_COMMANDS, MAX_CREATE_TICKET_COMMANDS, validateProposal, type ProposalBoard } from './proposal.ts';
import { MIN_BUDGET_USD } from './store.ts';

// This file tests the Manager proposal validator against malice, not just
// mistakes (per the Orchestrator's own framing for this batch): every test
// below either proves a legitimate proposal is accepted, or constructs a
// specific way a proposal could be structurally ruinous (a dependency
// cycle, a cap breach, a manager/work crossing, a dangling reference) and
// proves it is rejected WHOLE, with a reason, never partially applied.

// Batch 19 mini-phase 2A review fix (High 2 / Low 5): `resolveActiveProfileByName`
// replaces the old `activeProfiles` list -- a plain, case-INSENSITIVE-by-name
// (never by id) lookup here is exactly what these tests need; the review's
// finding was about the REAL implementation (managerApply.ts's, which calls
// store.ts's own getWorkerProfileByName) disagreeing with a second, hand-rolled
// fold, not about this test double's own folding rule needing to replicate
// SQLite's COLLATE NOCASE -- that specific disagreement is covered by
// managerApply.test.ts's real, db-backed "Éditeur"/"éditeur" test instead.
function activeProfileResolver(profiles: Array<{ id: string; name: string }>): ProposalBoard['resolveActiveProfileByName'] {
  return (name: string) => profiles.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

function emptyBoard(): ProposalBoard {
  return { tickets: [], dependencies: [], hasScopePath: true, resolveActiveProfileByName: activeProfileResolver([]) };
}

function boardWith(
  tickets: ProposalBoard['tickets'],
  dependencies: ProposalBoard['dependencies'] = [],
  activeProfiles: Array<{ id: string; name: string }> = []
): ProposalBoard {
  return { tickets, dependencies, hasScopePath: true, resolveActiveProfileByName: activeProfileResolver(activeProfiles) };
}

test('a minimal valid proposal (one create_ticket) is accepted', () => {
  const result = validateProposal(
    { rationale: 'split the mission into one ticket', commands: [
      { type: 'create_ticket', title: 'Do the thing', description: 'do it', acceptance_criteria: ['it is done'] },
    ] },
    emptyBoard()
  );
  assert.equal(result.valid, true);
});

test('a proposal exercising all seven commands together, with a legitimate cross-title dependency, is accepted', () => {
  const board = boardWith([
    { id: 'tkt_existing', title: 'Existing work', kind: 'work', status: 'OPEN' },
    { id: 'tkt_cancel_me', title: 'Cancel me', kind: 'work', status: 'READY' },
    { id: 'tkt_update_me', title: 'Update me', kind: 'work', status: 'OPEN' },
  ]);
  const result = validateProposal(
    {
      rationale: 'plan the mission',
      commands: [
        { type: 'create_ticket', title: 'A', description: 'a', acceptance_criteria: [] },
        { type: 'create_ticket', title: 'B', description: 'b', acceptance_criteria: [], depends_on: ['A', 'tkt_existing'] },
        { type: 'change_priority', ticket_id: 'tkt_existing', priority: 5 },
        { type: 'request_user_decision', question: 'Which library?', context: 'two options look equivalent' },
        { type: 'update_scope', content: 'Updated scope text.' },
        { type: 'cancel_ticket', ticket_id: 'tkt_cancel_me' },
        { type: 'update_ticket', ticket_id: 'tkt_update_me', title: 'New title' },
      ],
    },
    board
  );
  assert.equal(result.valid, true, result.valid ? '' : JSON.stringify((result as { errors: string[] }).errors));
});

test(`exactly ${MAX_COMMANDS} commands is accepted, ${MAX_COMMANDS + 1} is rejected`, () => {
  const makeCommands = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: 'create_ticket' as const,
      title: `T${i}`,
      description: 'd',
      acceptance_criteria: [],
    }));

  // MAX_COMMANDS itself would also breach MAX_CREATE_TICKET_COMMANDS if all
  // were create_ticket, so pad with change_priority against a real board
  // ticket instead, to isolate the command-count cap from the create cap.
  const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work' }]);
  const atCap = [
    ...makeCommands(MAX_CREATE_TICKET_COMMANDS),
    ...Array.from({ length: MAX_COMMANDS - MAX_CREATE_TICKET_COMMANDS }, () => ({
      type: 'change_priority' as const,
      ticket_id: 'tkt_x',
      priority: 1,
    })),
  ];
  assert.equal(atCap.length, MAX_COMMANDS);
  const okResult = validateProposal({ rationale: 'r', commands: atCap }, board);
  assert.equal(okResult.valid, true, okResult.valid ? '' : JSON.stringify((okResult as { errors: string[] }).errors));

  const overCap = [...atCap, { type: 'change_priority' as const, ticket_id: 'tkt_x', priority: 2 }];
  const rejected = validateProposal({ rationale: 'r', commands: overCap }, board);
  assert.equal(rejected.valid, false);
  assert.match((rejected as { errors: string[] }).errors.join(' '), /more than the cap/);
});

test(`exactly ${MAX_CREATE_TICKET_COMMANDS} create_ticket commands is accepted, ${MAX_CREATE_TICKET_COMMANDS + 1} is rejected`, () => {
  const makeCommands = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: 'create_ticket' as const,
      title: `CT${i}`,
      description: 'd',
      acceptance_criteria: [],
    }));

  const okResult = validateProposal({ rationale: 'r', commands: makeCommands(MAX_CREATE_TICKET_COMMANDS) }, emptyBoard());
  assert.equal(okResult.valid, true);

  const rejected = validateProposal({ rationale: 'r', commands: makeCommands(MAX_CREATE_TICKET_COMMANDS + 1) }, emptyBoard());
  assert.equal(rejected.valid, false);
  assert.match((rejected as { errors: string[] }).errors.join(' '), /create_ticket commands.*more than the cap/);
});

test('an unknown command type is rejected, not silently ignored', () => {
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'delete_ticket', ticket_id: 'tkt_x' }] },
    emptyBoard()
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /type must be one of/);
});

test('a proposal that is not a JSON object is rejected', () => {
  for (const raw of [null, 'a string', 42, ['array'], true]) {
    const result = validateProposal(raw, emptyBoard());
    assert.equal(result.valid, false, `expected ${JSON.stringify(raw)} to be rejected`);
  }
});

test('commands not an array, or rationale not a string, is rejected', () => {
  assert.equal(validateProposal({ rationale: 'r', commands: 'not an array' }, emptyBoard()).valid, false);
  assert.equal(validateProposal({ rationale: 123, commands: [] }, emptyBoard()).valid, false);
  assert.equal(validateProposal({ commands: [] }, emptyBoard()).valid, false);
});

test('create_ticket missing required fields is rejected, with an error naming each missing field', () => {
  const result = validateProposal({ rationale: 'r', commands: [{ type: 'create_ticket' }] }, emptyBoard());
  assert.equal(result.valid, false);
  const errors = (result as { errors: string[] }).errors.join(' ');
  assert.match(errors, /title/);
  assert.match(errors, /description/);
  assert.match(errors, /acceptance_criteria/);
});

// Batch 12 item 3: "Every create_ticket and update_ticket that sets a model
// carries a one-line model_reason" (batch-12-spec.md section 1 ruling 3) --
// enforced here, at the schema boundary, not left to convention.
test('create_ticket setting model without model_reason is rejected; with a non-empty model_reason it is accepted', () => {
  const withoutReason = validateProposal(
    {
      rationale: 'r',
      commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], model: 'claude-opus-5' }],
    },
    emptyBoard()
  );
  assert.equal(withoutReason.valid, false);
  assert.match((withoutReason as { errors: string[] }).errors.join(' '), /model_reason/);

  const emptyReason = validateProposal(
    {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], model: 'claude-opus-5', model_reason: '' },
      ],
    },
    emptyBoard()
  );
  assert.equal(emptyReason.valid, false, 'an empty string must not satisfy the requirement');

  const withReason = validateProposal(
    {
      rationale: 'r',
      commands: [
        {
          type: 'create_ticket',
          title: 'T',
          description: 'd',
          acceptance_criteria: [],
          model: 'claude-opus-5',
          model_reason: 'this ticket needs deep design trade-offs',
        },
      ],
    },
    emptyBoard()
  );
  assert.equal(withReason.valid, true, withReason.valid ? '' : JSON.stringify((withReason as { errors: string[] }).errors));
});

test('create_ticket/update_ticket with no model set at all needs no model_reason', () => {
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [] }] },
    emptyBoard()
  );
  assert.equal(result.valid, true);
});

test('update_ticket setting model without model_reason is rejected; with one it is accepted', () => {
  const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: 'OPEN' }]);

  const withoutReason = validateProposal(
    { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', model: 'claude-sonnet-5' }] },
    board
  );
  assert.equal(withoutReason.valid, false);
  assert.match((withoutReason as { errors: string[] }).errors.join(' '), /model_reason/);

  const withReason = validateProposal(
    {
      rationale: 'r',
      commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', model: 'claude-sonnet-5', model_reason: 'implementation work, not design' }],
    },
    board
  );
  assert.equal(withReason.valid, true, withReason.valid ? '' : JSON.stringify((withReason as { errors: string[] }).errors));
});

// Batch 13 ruling 1a: "agents do not decide where work lives" -- neither
// create_ticket nor update_ticket may set workspace_type at all any more,
// even to a value that was previously legal (e.g. 'DIRECTORY' itself).
// Checked as a raw payload (not via the typed ManagerCommand union, which
// no longer has the field), since a smuggled key must be caught the same
// way "status" already is on update_ticket.
test('create_ticket carrying a "workspace_type" field is rejected outright, naming the field, even when its value would have been valid before this batch', () => {
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], workspace_type: 'DIRECTORY' },
      ],
    },
    emptyBoard()
  );
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes('workspace_type')));
  }
});

test('update_ticket carrying a "workspace_type" field is rejected outright, naming the field', () => {
  const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: 'OPEN' }]);
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', workspace_type: 'NONE' }] },
    board
  );
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes('workspace_type')));
  }
});

test('create_ticket with no workspace_type field at all is accepted (the ordinary case)', () => {
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [] }] },
    emptyBoard()
  );
  assert.equal(result.valid, true);
});

// --- Batch 15 item 4: expected_artifacts on create_ticket/update_ticket ---

test('create_ticket/update_ticket with a valid expected_artifacts list are accepted', () => {
  const created = validateProposal(
    {
      rationale: 'r',
      commands: [
        {
          type: 'create_ticket',
          title: 'T',
          description: 'd',
          acceptance_criteria: [],
          expected_artifacts: [{ kind: 'file', path: 'out.txt' }, { kind: 'text' }],
        },
      ],
    },
    emptyBoard()
  );
  assert.equal(created.valid, true);

  const updated = validateProposal(
    {
      rationale: 'r',
      commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', expected_artifacts: [{ kind: 'file', path: 'a.txt' }] }],
    },
    boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: 'OPEN' }])
  );
  assert.equal(updated.valid, true);
});

test('create_ticket.expected_artifacts rejects a non-array, a non-object entry, an unknown kind, kind "file" with no path, and any other kind carrying a path', () => {
  const cases: unknown[] = [
    'not-an-array',
    ['not-an-object'],
    [{ kind: 'not-a-real-kind' }],
    [{ kind: 'file' }],
    [{ kind: 'file', path: '' }],
    [{ kind: 'text', path: 'should-not-be-here.txt' }],
  ];
  for (const expected_artifacts of cases) {
    const result = validateProposal(
      { rationale: 'r', commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], expected_artifacts }] },
      emptyBoard()
    );
    assert.equal(result.valid, false, `expected rejection for expected_artifacts: ${JSON.stringify(expected_artifacts)}`);
  }
});

test('update_ticket.expected_artifacts is validated the same way as create_ticket\'s', () => {
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', expected_artifacts: [{ kind: 'file' }] }],
    },
    boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: 'OPEN' }])
  );
  assert.equal(result.valid, false);
});

test('MANAGER_COMMAND_SCHEMA_DESCRIPTION names expected_artifacts on both create_ticket and update_ticket -- the Manager\'s own wording is data this test reads back', () => {
  const description = MANAGER_COMMAND_SCHEMA_DESCRIPTION;
  const createLine = description.split('\n').find((l) => l.includes('"type": "create_ticket"'))!;
  const updateLine = description.split('\n').find((l) => l.includes('"type": "update_ticket"'))!;
  assert.match(createLine, /expected_artifacts/);
  assert.match(updateLine, /expected_artifacts/);
});

test('add_dependency missing fields, change_priority with a non-number priority, and request_user_decision missing question are each rejected', () => {
  assert.equal(validateProposal({ rationale: 'r', commands: [{ type: 'add_dependency', ticket_id: 'x' }] }, emptyBoard()).valid, false);
  assert.equal(
    validateProposal({ rationale: 'r', commands: [{ type: 'change_priority', ticket_id: 'x', priority: '5' }] }, emptyBoard()).valid,
    false
  );
  assert.equal(
    validateProposal({ rationale: 'r', commands: [{ type: 'request_user_decision', context: 'c' }] }, emptyBoard()).valid,
    false
  );
  assert.equal(validateProposal({ rationale: 'r', commands: [{ type: 'update_scope' }] }, emptyBoard()).valid, false);
  assert.equal(validateProposal({ rationale: 'r', commands: [{ type: 'cancel_ticket' }] }, emptyBoard()).valid, false);
  assert.equal(validateProposal({ rationale: 'r', commands: [{ type: 'update_ticket' }] }, emptyBoard()).valid, false);
});

test('update_project_brief is no longer a recognized command (removed in favour of update_scope, batch 11)', () => {
  const result = validateProposal({ rationale: 'r', commands: [{ type: 'update_project_brief', brief: 'x' }] }, emptyBoard());
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /type must be one of/);
});

test('create_ticket.max_budget_usd below MIN_BUDGET_USD is rejected, naming the floor; exactly at the floor is accepted', () => {
  const tooLow = validateProposal(
    { rationale: 'r', commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], max_budget_usd: 0.01 }] },
    emptyBoard()
  );
  assert.equal(tooLow.valid, false);
  assert.match((tooLow as { errors: string[] }).errors.join(' '), /at least/);

  const atFloor = validateProposal(
    {
      rationale: 'r',
      commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], max_budget_usd: MIN_BUDGET_USD }],
    },
    emptyBoard()
  );
  assert.equal(atFloor.valid, true);
});

test('a create_ticket title colliding with an existing board ticket is rejected', () => {
  const board = boardWith([{ id: 'tkt_1', title: 'Duplicate', kind: 'work' }]);
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'create_ticket', title: 'Duplicate', description: 'd', acceptance_criteria: [] }] },
    board
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /already exists on the board/);
});

test('two create_ticket commands declaring the same title within one proposal are rejected', () => {
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'Same', description: 'd1', acceptance_criteria: [] },
        { type: 'create_ticket', title: 'Same', description: 'd2', acceptance_criteria: [] },
      ],
    },
    emptyBoard()
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /declared more than once/);
});

test('create_ticket.depends_on referencing neither an existing id nor a same-proposal title is rejected (dangling reference)', () => {
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], depends_on: ['tkt_ghost'] }],
    },
    emptyBoard()
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /neither an existing ticket id nor another create_ticket/);
});

test('add_dependency referencing a ticket that does not exist on the board is rejected (both fields checked independently)', () => {
  const board = boardWith([{ id: 'tkt_real', title: 'Real', kind: 'work' }]);
  const missingTicket = validateProposal(
    { rationale: 'r', commands: [{ type: 'add_dependency', ticket_id: 'tkt_ghost', depends_on_ticket_id: 'tkt_real' }] },
    board
  );
  assert.equal(missingTicket.valid, false);

  const missingDependsOn = validateProposal(
    { rationale: 'r', commands: [{ type: 'add_dependency', ticket_id: 'tkt_real', depends_on_ticket_id: 'tkt_ghost' }] },
    board
  );
  assert.equal(missingDependsOn.valid, false);

  // A title is not an id: even though a create_ticket in the SAME proposal
  // declares this exact title, add_dependency must not resolve it.
  const titleNotId = validateProposal(
    {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'New one', description: 'd', acceptance_criteria: [] },
        { type: 'add_dependency', ticket_id: 'tkt_real', depends_on_ticket_id: 'New one' },
      ],
    },
    board
  );
  assert.equal(titleNotId.valid, false, 'add_dependency must only resolve existing ids, never a same-proposal title');
});

test('change_priority referencing a ticket that does not exist on the board is rejected', () => {
  const result = validateProposal({ rationale: 'r', commands: [{ type: 'change_priority', ticket_id: 'tkt_ghost', priority: 1 }] }, emptyBoard());
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /not an existing ticket/);
});

// --- Manager/work never depend on each other (batch-9-spec.md section 2) ---

test('add_dependency is rejected when either side is an existing manager ticket, in both directions', () => {
  const board = boardWith([
    { id: 'tkt_work', title: 'Work', kind: 'work' },
    { id: 'tkt_mgr', title: 'Manager run', kind: 'manager' },
  ]);

  const workDependsOnManager = validateProposal(
    { rationale: 'r', commands: [{ type: 'add_dependency', ticket_id: 'tkt_work', depends_on_ticket_id: 'tkt_mgr' }] },
    board
  );
  assert.equal(workDependsOnManager.valid, false);
  assert.match((workDependsOnManager as { errors: string[] }).errors.join(' '), /manager ticket/);

  const managerDependsOnWork = validateProposal(
    { rationale: 'r', commands: [{ type: 'add_dependency', ticket_id: 'tkt_mgr', depends_on_ticket_id: 'tkt_work' }] },
    board
  );
  assert.equal(managerDependsOnWork.valid, false);
  assert.match((managerDependsOnWork as { errors: string[] }).errors.join(' '), /manager ticket/);
});

test('create_ticket.depends_on referencing an existing manager ticket is rejected', () => {
  const board = boardWith([{ id: 'tkt_mgr', title: 'Manager run', kind: 'manager' }]);
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [{ type: 'create_ticket', title: 'New work', description: 'd', acceptance_criteria: [], depends_on: ['tkt_mgr'] }],
    },
    board
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /manager ticket/);
});

// --- Cycle rejection: the caps and the manager/work rule guard specific
// shapes; this section is the general defence against an LLM proposing
// something structurally ruinous, per the Orchestrator's own framing. ---

test('a direct two-ticket cycle between two NEW tickets (A depends on B, B depends on A) is rejected', () => {
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'A', description: 'd', acceptance_criteria: [], depends_on: ['B'] },
        { type: 'create_ticket', title: 'B', description: 'd', acceptance_criteria: [], depends_on: ['A'] },
      ],
    },
    emptyBoard()
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /dependency cycle/);
});

test('a longer cycle among NEW tickets (A -> B -> C -> A) is rejected', () => {
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'A', description: 'd', acceptance_criteria: [], depends_on: ['B'] },
        { type: 'create_ticket', title: 'B', description: 'd', acceptance_criteria: [], depends_on: ['C'] },
        { type: 'create_ticket', title: 'C', description: 'd', acceptance_criteria: [], depends_on: ['A'] },
      ],
    },
    emptyBoard()
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /dependency cycle/);
});

test('a create_ticket depending on its own not-yet-assigned title is rejected as a self-cycle', () => {
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'create_ticket', title: 'Self', description: 'd', acceptance_criteria: [], depends_on: ['Self'] }] },
    emptyBoard()
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /dependency cycle/);
});

test('add_dependency making an existing ticket depend on itself is rejected as a self-cycle', () => {
  const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work' }]);
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'add_dependency', ticket_id: 'tkt_x', depends_on_ticket_id: 'tkt_x' }] },
    board
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /dependency cycle/);
});

test('a cycle introduced purely by closing a loop back to an EXISTING board dependency is rejected', () => {
  // Existing board already has X depends on Y (Y must finish before X).
  // The proposal adds Y depends on X -- closing the loop entirely through
  // add_dependency, with no new tickets involved at all.
  const board = boardWith(
    [
      { id: 'tkt_x', title: 'X', kind: 'work' },
      { id: 'tkt_y', title: 'Y', kind: 'work' },
    ],
    [{ ticketId: 'tkt_x', dependsOnTicketId: 'tkt_y' }]
  );
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'add_dependency', ticket_id: 'tkt_y', depends_on_ticket_id: 'tkt_x' }] },
    board
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /dependency cycle/);
});

test('a cycle spanning existing tickets and a brand-new one is rejected (new ticket depends on existing, existing gets a new dependency back on it via add_dependency requires two commands -- proven via create_ticket + add_dependency together)', () => {
  const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work' }]);
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [
        // New ticket N depends on existing X.
        { type: 'create_ticket', title: 'N', description: 'd', acceptance_criteria: [], depends_on: ['tkt_x'] },
        // Existing X depends on new N -- closes the loop X -> N -> X.
        // add_dependency cannot reference a not-yet-created ticket by id,
        // so this specific shape is exercised through the dangling-reference
        // path instead; the real cross-existing-and-new cycle is already
        // covered by the two tests above (existing-only and new-only). This
        // test instead proves a legitimate non-cyclic new-depends-on-existing
        // edge is accepted, as the negative-space check for the cycle tests.
      ],
    },
    board
  );
  assert.equal(result.valid, true, 'a new ticket depending on an existing one, with no loop, must be accepted');
});

test('a legitimate diamond-shaped dependency graph (no cycle) is accepted, proving the cycle check does not false-positive on shared dependencies', () => {
  // Index depends on both Sqlite and Wal; both of those depend on Intro.
  // A naive "any repeated visit is a cycle" check would wrongly reject this.
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'Intro', description: 'd', acceptance_criteria: [] },
        { type: 'create_ticket', title: 'Sqlite', description: 'd', acceptance_criteria: [], depends_on: ['Intro'] },
        { type: 'create_ticket', title: 'Wal', description: 'd', acceptance_criteria: [], depends_on: ['Intro'] },
        { type: 'create_ticket', title: 'Index', description: 'd', acceptance_criteria: [], depends_on: ['Sqlite', 'Wal'] },
      ],
    },
    emptyBoard()
  );
  assert.equal(result.valid, true, result.valid ? '' : JSON.stringify((result as { errors: string[] }).errors));
});

// --- Batch 11 item 4: cancel_ticket / update_ticket ---

test('update_scope with a valid string content is accepted', () => {
  const result = validateProposal({ rationale: 'r', commands: [{ type: 'update_scope', content: 'New scope text.' }] }, emptyBoard());
  assert.equal(result.valid, true, result.valid ? '' : JSON.stringify((result as { errors: string[] }).errors));
});

// Batch 16 ruling 24 point 4: defence in depth. The scheduler's readiness
// check pauses a scope-less project before any Manager run starts, so no
// envelope is built for one and this branch is UNREACHABLE in practice -- it
// stays so that a future path around the check still fails with a clean
// validation error rather than an unhandled write failure.
test('update_scope is rejected as a clean validation error, not an unhandled write failure, when the project has no scope_path set yet (unreachable in practice: readiness pauses such a project first)', () => {
  const board: ProposalBoard = { tickets: [], dependencies: [], hasScopePath: false, resolveActiveProfileByName: activeProfileResolver([]) };
  const result = validateProposal({ rationale: 'r', commands: [{ type: 'update_scope', content: 'x' }] }, board);
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /no scope_path set/);
});

test('cancel_ticket targeting an existing, cancellable work ticket is accepted', () => {
  const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: 'READY' }]);
  const result = validateProposal({ rationale: 'r', commands: [{ type: 'cancel_ticket', ticket_id: 'tkt_x' }] }, board);
  assert.equal(result.valid, true, result.valid ? '' : JSON.stringify((result as { errors: string[] }).errors));
});

test('cancel_ticket targeting a ticket that does not exist on the board is rejected', () => {
  const result = validateProposal({ rationale: 'r', commands: [{ type: 'cancel_ticket', ticket_id: 'tkt_ghost' }] }, emptyBoard());
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /not an existing ticket/);
});

test('cancel_ticket targeting a manager ticket is rejected', () => {
  const board = boardWith([{ id: 'tkt_mgr', title: 'Manager run', kind: 'manager', status: 'READY' }]);
  const result = validateProposal({ rationale: 'r', commands: [{ type: 'cancel_ticket', ticket_id: 'tkt_mgr' }] }, board);
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /manager ticket/);
});

for (const terminalStatus of ['DONE', 'FAILED', 'CANCELLED']) {
  test(`cancel_ticket targeting a ticket already ${terminalStatus} is rejected, not left to throw at apply time`, () => {
    const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: terminalStatus as never }]);
    const result = validateProposal({ rationale: 'r', commands: [{ type: 'cancel_ticket', ticket_id: 'tkt_x' }] }, board);
    assert.equal(result.valid, false);
    assert.match((result as { errors: string[] }).errors.join(' '), /cannot be cancelled/);
  });
}

for (const cancellableStatus of ['OPEN', 'READY', 'IN_PROGRESS', 'REVIEW']) {
  test(`cancel_ticket targeting a ${cancellableStatus} ticket is accepted`, () => {
    const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: cancellableStatus as never }]);
    const result = validateProposal({ rationale: 'r', commands: [{ type: 'cancel_ticket', ticket_id: 'tkt_x' }] }, board);
    assert.equal(result.valid, true, result.valid ? '' : JSON.stringify((result as { errors: string[] }).errors));
  });
}

test('update_ticket with a partial set of fields (title only) targeting an existing work ticket is accepted', () => {
  const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: 'OPEN' }]);
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', title: 'New title' }] },
    board
  );
  assert.equal(result.valid, true, result.valid ? '' : JSON.stringify((result as { errors: string[] }).errors));
});

test('update_ticket targeting a ticket that does not exist on the board is rejected', () => {
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_ghost', title: 'New title' }] },
    emptyBoard()
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /not an existing ticket/);
});

test('update_ticket targeting a manager ticket is rejected', () => {
  const board = boardWith([{ id: 'tkt_mgr', title: 'Manager run', kind: 'manager', status: 'READY' }]);
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_mgr', title: 'New title' }] },
    board
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /manager ticket/);
});

test('update_ticket with an invalid field type (max_budget_usd below the floor) is rejected, naming the floor', () => {
  const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: 'OPEN' }]);
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', max_budget_usd: 0.01 }] },
    board
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /at least/);
});

test('update_ticket carrying a "status" field is rejected outright -- a proposal may never set status directly, even if the field is present in the raw JSON', () => {
  const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: 'OPEN' }]);
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', status: 'DONE' }] },
    board
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /never set it directly/);
});

test('every error is reported together, not just the first one found', () => {
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [
        { type: 'change_priority', ticket_id: 'tkt_ghost_1', priority: 1 },
        { type: 'add_dependency', ticket_id: 'tkt_ghost_2', depends_on_ticket_id: 'tkt_ghost_3' },
      ],
    },
    emptyBoard()
  );
  assert.equal(result.valid, false);
  const errors = (result as { errors: string[] }).errors;
  assert.ok(errors.length >= 3, `expected at least 3 distinct errors (one ticket + two from add_dependency), got: ${JSON.stringify(errors)}`);
});

// --- Batch 19 mini-phase 2A (ruling 37): "profile" / "profile_reason" ---

test('create_ticket assigning an active profile by name, with a reason, is accepted', () => {
  const board = boardWith([], [], [{ id: 'prof_dev', name: 'Developer' }]);
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [
        {
          type: 'create_ticket',
          title: 'T',
          description: 'd',
          acceptance_criteria: [],
          profile: 'Developer',
          profile_reason: 'ordinary implementation work',
        },
      ],
    },
    board
  );
  assert.equal(result.valid, true, result.valid ? '' : JSON.stringify((result as { errors: string[] }).errors));
});

test('create_ticket matches a profile name case-insensitively, the same lookup 1A uses', () => {
  const board = boardWith([], [], [{ id: 'prof_dev', name: 'Developer' }]);
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], profile: 'developer', profile_reason: 'why' },
      ],
    },
    board
  );
  assert.equal(result.valid, true, result.valid ? '' : JSON.stringify((result as { errors: string[] }).errors));
});

test('create_ticket setting profile without profile_reason is rejected; an empty profile_reason is also rejected', () => {
  const board = boardWith([], [], [{ id: 'prof_dev', name: 'Developer' }]);
  const withoutReason = validateProposal(
    { rationale: 'r', commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], profile: 'Developer' }] },
    board
  );
  assert.equal(withoutReason.valid, false);
  assert.match((withoutReason as { errors: string[] }).errors.join(' '), /profile_reason/);

  const emptyReason = validateProposal(
    {
      rationale: 'r',
      commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], profile: 'Developer', profile_reason: '' }],
    },
    board
  );
  assert.equal(emptyReason.valid, false, 'an empty string must not satisfy the requirement');
});

// Refusal 1: an unknown or retired profile name.
test('create_ticket assigning a profile name that is not on the active roster is rejected -- covers both "does not exist" and "is retired" (retired profiles are simply absent from activeProfiles)', () => {
  const board = boardWith([], [], [{ id: 'prof_dev', name: 'Developer' }]);
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [
        { type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], profile: 'Nonexistent', profile_reason: 'why' },
      ],
    },
    board
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /not a known, active worker profile/);
});

// Review fix (Low 5): ruling 37 and the grammar say "profile" is a NAME,
// never an id -- a `prof_...` id must be refused the same as any other
// unrecognized string, even when it is the real id of a real active
// profile.
test('create_ticket assigning a profile by its id (not its name) is rejected -- "profile" is a name only', () => {
  const board = boardWith([], [], [{ id: 'prof_dev', name: 'Developer' }]);
  const result = validateProposal(
    {
      rationale: 'r',
      commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], profile: 'prof_dev', profile_reason: 'why' }],
    },
    board
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /not a known, active worker profile/);
});

// Refusal 2: profile together with model.
test('create_ticket setting both profile and model is rejected with the "choose a profile or a model" sentence, and update_ticket too', () => {
  const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: 'OPEN' }], [], [{ id: 'prof_dev', name: 'Developer' }]);

  const created = validateProposal(
    {
      rationale: 'r',
      commands: [
        {
          type: 'create_ticket',
          title: 'T',
          description: 'd',
          acceptance_criteria: [],
          profile: 'Developer',
          profile_reason: 'why',
          model: 'claude-sonnet-5',
          model_reason: 'why',
        },
      ],
    },
    board
  );
  assert.equal(created.valid, false);
  assert.match((created as { errors: string[] }).errors.join(' '), /choose a profile or a model, not both/);

  const updated = validateProposal(
    {
      rationale: 'r',
      commands: [
        { type: 'update_ticket', ticket_id: 'tkt_x', profile: 'Developer', profile_reason: 'why', model: 'claude-sonnet-5', model_reason: 'why' },
      ],
    },
    board
  );
  assert.equal(updated.valid, false);
  assert.match((updated as { errors: string[] }).errors.join(' '), /choose a profile or a model, not both/);
});

// Review fix (High 1): the exclusivity check must also catch a command that
// only touches ONE of the two fields when the ticket's OWN existing row
// already carries the other -- not just both set on the same command.
test('update_ticket adding a profile to a ticket that already has a bare model is rejected against the RESULTING row', () => {
  const board = boardWith(
    [{ id: 'tkt_x', title: 'X', kind: 'work', status: 'OPEN', model: 'claude-sonnet-5' }],
    [],
    [{ id: 'prof_dev', name: 'Developer' }]
  );
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', profile: 'Developer', profile_reason: 'why' }] },
    board
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /choose a profile or a model, not both/);
});

test('update_ticket adding a model to a ticket that already has a profile is rejected against the RESULTING row', () => {
  const board = boardWith(
    [{ id: 'tkt_x', title: 'X', kind: 'work', status: 'OPEN', profileId: 'prof_dev' }],
    [],
    [{ id: 'prof_dev', name: 'Developer' }]
  );
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', model: 'claude-sonnet-5', model_reason: 'why' }] },
    board
  );
  assert.equal(result.valid, false);
  assert.match((result as { errors: string[] }).errors.join(' '), /choose a profile or a model, not both/);
});

test('update_ticket setting only "model" (no "profile" in the command) on a ticket that has neither yet is accepted -- the resulting-row check does not false-positive on an ordinary model set', () => {
  const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: 'OPEN' }]);
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', model: 'claude-sonnet-5', model_reason: 'why' }] },
    board
  );
  assert.equal(result.valid, true, result.valid ? '' : JSON.stringify((result as { errors: string[] }).errors));
});

// Refusal 3: update_ticket changing the profile of a ticket that is IN_PROGRESS or REVIEW.
for (const lockedStatus of ['IN_PROGRESS', 'REVIEW']) {
  test(`update_ticket changing the profile of a ${lockedStatus} ticket is rejected`, () => {
    const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: lockedStatus as never }], [], [{ id: 'prof_dev', name: 'Developer' }]);
    const result = validateProposal(
      { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', profile: 'Developer', profile_reason: 'why' }] },
      board
    );
    assert.equal(result.valid, false);
    assert.match((result as { errors: string[] }).errors.join(' '), new RegExp(lockedStatus));
  });
}

for (const openStatus of ['OPEN', 'READY']) {
  test(`update_ticket changing the profile of an ${openStatus} ticket is accepted`, () => {
    const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: openStatus as never }], [], [{ id: 'prof_dev', name: 'Developer' }]);
    const result = validateProposal(
      { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', profile: 'Developer', profile_reason: 'why' }] },
      board
    );
    assert.equal(result.valid, true, result.valid ? '' : JSON.stringify((result as { errors: string[] }).errors));
  });
}

test('create_ticket/update_ticket with no profile set at all needs no profile_reason', () => {
  const result = validateProposal(
    { rationale: 'r', commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [] }] },
    emptyBoard()
  );
  assert.equal(result.valid, true);
});

// Second reviewer's Low 8: the pairing runs both ways -- a reason with no
// profile to justify it is meaningless and is rejected outright, the mirror
// of "profile requires a reason".
test('create_ticket/update_ticket setting profile_reason WITHOUT profile is rejected', () => {
  const createResult = validateProposal(
    { rationale: 'r', commands: [{ type: 'create_ticket', title: 'T', description: 'd', acceptance_criteria: [], profile_reason: 'orphaned reason' }] },
    emptyBoard()
  );
  assert.equal(createResult.valid, false);
  assert.match((createResult as { errors: string[] }).errors.join(' '), /profile_reason must not be set without profile/);

  const board = boardWith([{ id: 'tkt_x', title: 'X', kind: 'work', status: 'OPEN' }]);
  const updateResult = validateProposal(
    { rationale: 'r', commands: [{ type: 'update_ticket', ticket_id: 'tkt_x', profile_reason: 'orphaned reason' }] },
    board
  );
  assert.equal(updateResult.valid, false);
  assert.match((updateResult as { errors: string[] }).errors.join(' '), /profile_reason must not be set without profile/);
});

test('MANAGER_COMMAND_SCHEMA_DESCRIPTION mentions profile and profile_reason on both create_ticket and update_ticket', () => {
  assert.match(MANAGER_COMMAND_SCHEMA_DESCRIPTION, /"profile"/);
  assert.match(MANAGER_COMMAND_SCHEMA_DESCRIPTION, /"profile_reason"/);
  assert.match(MANAGER_COMMAND_SCHEMA_DESCRIPTION, /choose a profile or a model, not both/);
});
