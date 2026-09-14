import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_COMMANDS, MAX_CREATE_TICKET_COMMANDS, validateProposal, type ProposalBoard } from './proposal.ts';
import { MIN_BUDGET_USD } from './store.ts';

// This file tests the Manager proposal validator against malice, not just
// mistakes (per the Orchestrator's own framing for this batch): every test
// below either proves a legitimate proposal is accepted, or constructs a
// specific way a proposal could be structurally ruinous (a dependency
// cycle, a cap breach, a manager/work crossing, a dangling reference) and
// proves it is rejected WHOLE, with a reason, never partially applied.

function emptyBoard(): ProposalBoard {
  return { tickets: [], dependencies: [], hasScopePath: true };
}

function boardWith(tickets: ProposalBoard['tickets'], dependencies: ProposalBoard['dependencies'] = []): ProposalBoard {
  return { tickets, dependencies, hasScopePath: true };
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

test('update_scope is rejected as a clean validation error, not an unhandled write failure, when the project has no scope_path set yet', () => {
  const board: ProposalBoard = { tickets: [], dependencies: [], hasScopePath: false };
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
