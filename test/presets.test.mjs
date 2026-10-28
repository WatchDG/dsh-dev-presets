// Declaration checks for every preset patch in presets/.
//
// The preset files are the payload of this bundle, so the suite validates
// their structure without a Harness: one `@deepseek-ai/dsh-agent-preset`
// declaration per file, resolvable plugin rows, unique identities, and the
// architect role contract (identity prompt, toolset, deliberate exclusions).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

/** Preset declaration package, and the Loader group marker used for nesting. */
const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset'
const GROUP_NAME = 'cordis:group'

/** Loader `!!js` scalars are evaluation-only; keep the expression as data. */
const JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value) => ({ __jsExpr: String(value) }),
}

const presetFiles = readdirSync(path.join(root, 'presets'))
  .filter((entry) => entry.endsWith('.patch.yml'))
  .sort()

const declarations = presetFiles.map((file) => {
  const document = parse(read(`presets/${file}`), { customTags: [JS_TAG] })
  return { file, document, row: document?.[0]?.insert?.[0] }
})

const configOf = ({ row }) => row.config
const pluginsOf = (declaration) => configOf(declaration).plugins
const rowIds = (declaration) => pluginsOf(declaration).map((plugin) => plugin.id)

const isJsExpression = (value) =>
  typeof value === 'object' && value !== null && typeof value.__jsExpr === 'string' && Object.keys(value).length === 1

test('the suite sees at least one preset', () => {
  assert.ok(presetFiles.length > 0, 'presets/ contains no patch file')
})

test('every preset file is one insert of one preset declaration', () => {
  for (const declaration of declarations) {
    const { file, document, row } = declaration
    assert.ok(Array.isArray(document), `${file} is a YAML entry list`)
    assert.equal(document.length, 1, `${file} holds exactly one patch entry`)
    assert.ok(Array.isArray(document[0].insert), `${file} inserts rows`)
    assert.equal(document[0].insert.length, 1, `${file} inserts exactly one row`)
    assert.ok(row && typeof row === 'object', `${file} row is a mapping`)
    assert.equal(row.name, PRESET_PACKAGE, `${file} row declares the agent preset package`)
    assert.ok(row.config && typeof row.config === 'object', `${file} row carries a config`)
  }
})

test('preset identities are named and unique across the bundle', () => {
  const ids = new Set()
  const orders = new Set()

  for (const declaration of declarations) {
    const { file, row } = declaration
    const config = configOf(declaration)
    const base = file.replace(/^presets\//, '').replace(/\.patch\.yml$/, '')

    assert.equal(typeof config.id, 'string', `${file} declares a preset id`)
    assert.match(config.id, /^[a-z][a-z0-9-]*$/, `${file} preset id is lowercase kebab-case`)
    assert.equal(config.id, base, `${file} preset id matches its file name`)
    assert.equal(row.id, `preset-${config.id}`, `${file} row id addresses the preset by Loader id`)
    assert.equal(typeof config.name, 'string', `${file} declares a display name`)
    assert.ok(config.name.length > 0, `${file} display name is empty`)
    assert.equal(typeof config.description, 'string', `${file} declares a description`)
    assert.ok(config.description.length > 0, `${file} description is empty`)
    assert.ok(Number.isInteger(config.order) && config.order > 0, `${file} declares a positive order`)

    assert.ok(!ids.has(config.id), `duplicate preset id: ${config.id}`)
    assert.ok(!orders.has(config.order), `duplicate preset order: ${config.order}`)
    ids.add(config.id)
    orders.add(config.order)
  }
})

test('plugin rows are resolvable and uniquely identified', () => {
  for (const declaration of declarations) {
    const { file } = declaration
    const plugins = pluginsOf(declaration)
    assert.ok(Array.isArray(plugins) && plugins.length > 0, `${file} composes at least one plugin row`)

    const ids = new Set()
    for (const plugin of plugins) {
      assert.ok(plugin && typeof plugin === 'object', `${file} has a non-mapping plugin row`)
      assert.equal(typeof plugin.id, 'string', `${file} has a plugin row without id`)
      assert.ok(!ids.has(plugin.id), `${file} duplicates plugin row id: ${plugin.id}`)
      ids.add(plugin.id)

      if (plugin.name === GROUP_NAME) {
        assert.equal(plugin.group, true, `${file} group row ${plugin.id} sets group: true`)
        assert.ok(Array.isArray(plugin.config), `${file} group row ${plugin.id} nests an entry list`)
      } else {
        assert.match(
          plugin.name,
          /^@deepseek-ai\/dsh-[a-z0-9-]+(\/[a-z0-9-]+)?$/,
          `${file} row ${plugin.id} names a Harness plugin package`,
        )
      }

      if (plugin.disabled !== undefined) {
        assert.ok(isJsExpression(plugin.disabled), `${file} row ${plugin.id} gates activation with !!js`)
      }
    }
  }
})

test('every preset lends the agent an identity prompt', () => {
  for (const declaration of declarations) {
    const { file } = declaration
    const personas = pluginsOf(declaration).filter((plugin) => plugin.id === 'persona')
    assert.equal(personas.length, 1, `${file} mounts exactly one persona row`)
    assert.equal(personas[0].name, '@deepseek-ai/dsh-persona')

    const prefix = personas[0].config?.prefix
    assert.equal(typeof prefix, 'string', `${file} persona carries a prefix`)
    assert.ok(prefix.trim().length > 0, `${file} persona prefix is empty`)
    assert.ok(!prefix.includes('\u2019'), `${file} persona prefix uses straight apostrophes`)
  }
})

test('every preset forbids commits without an explicit user instruction', () => {
  for (const declaration of declarations) {
    const { file } = declaration
    const persona = pluginsOf(declaration).find((plugin) => plugin.id === 'persona')
    const prefix = persona.config.prefix

    assert.ok(
      prefix.includes('# Mandatory Rule: No Commits Without Explicit User Instruction'),
      `${file} carries the mandatory commit rule`,
    )
    assert.ok(
      prefix.includes(
        'Never create, amend, or otherwise rewrite a git commit unless the user explicitly instructs you to commit in the current task.',
      ),
      `${file} requires explicit user instruction before committing`,
    )
    assert.ok(
      prefix.includes('Editing, creating, or verifying files is not authorization to commit them.'),
      `${file} keeps file work distinct from commit authorization`,
    )
  }
})

test('the architect preset composes the architect role toolset', () => {
  const architect = declarations.find((declaration) => configOf(declaration).id === 'architect')
  assert.ok(architect, 'the architect preset exists')

  const ids = rowIds(architect)
  const expected = [
    'persona',
    'agent-instructions',
    'time-context',
    'tool-bash',
    'tool-pwsh',
    'tool-fs',
    'tool-fs-search',
    'tool-jobs',
    'skill-filesystem',
    'tool-skill',
    'compaction',
    'tool-ask-user',
    'tool-todo',
    'tool-web',
    'present',
  ]
  assert.deepEqual(ids, expected, 'the architect toolset matches its documented contract')
})

test('the architect preset deliberately omits unrelated capabilities', () => {
  const architect = declarations.find((declaration) => configOf(declaration).id === 'architect')
  const ids = rowIds(architect)

  // Stage approval lives in the persona contract; plan mode would block the
  // concept-stage documentation writes and duplicate the approval gate.
  for (const omitted of ['plan-mode', 'planning']) {
    assert.ok(!ids.includes(omitted), `architect must not compose ${omitted}`)
  }
  // Implementing is another model's stage, so the architect never delegates.
  for (const omitted of ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-workflow', 'workflow-ptc']) {
    assert.ok(!ids.includes(omitted), `architect must not compose ${omitted}`)
  }
  // Goals auto-continue across rounds and conflict with "stop after each stage".
  for (const omitted of ['command-goal', 'tool-goal', 'tool-schedule']) {
    assert.ok(!ids.includes(omitted), `architect must not compose ${omitted}`)
  }
})

test('the architect preset gates one shell per platform', () => {
  const architect = declarations.find((declaration) => configOf(declaration).id === 'architect')
  const plugins = pluginsOf(architect)
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]))

  assert.equal(byId.get('tool-bash').disabled.__jsExpr, "process.platform === 'win32'")
  assert.equal(byId.get('tool-pwsh').disabled.__jsExpr, "process.platform !== 'win32'")
})

test('the architect preset keeps head/tail compaction with a pruner', () => {
  const architect = declarations.find((declaration) => configOf(declaration).id === 'architect')
  const group = pluginsOf(architect).find((plugin) => plugin.id === 'compaction')

  assert.ok(group, 'the architect preset mounts the compaction group')
  assert.deepEqual(group.isolate, { compaction: true, toolResultPruner: true })
  assert.deepEqual(
    group.config.map((plugin) => plugin.id),
    ['compaction-basic', 'command-compact', 'tool-result-pruner'],
  )
})

test('the architect persona prompt is the complete concept-and-plan contract', () => {
  const architect = declarations.find((declaration) => configOf(declaration).id === 'architect')
  const persona = pluginsOf(architect).find((plugin) => plugin.id === 'persona')
  const prefix = persona.config.prefix

  assert.ok(!prefix.includes('\r'), 'the prompt stores LF line endings')
  assert.ok(!/[ \t]\n/.test(prefix), 'the prompt has no trailing whitespace')
  assert.ok(!/\{\{/.test(prefix), 'the prompt uses no unregistered template variables')
  assert.ok(prefix.endsWith('\n'), 'the prompt ends with a newline')
  assert.notEqual(persona.config.complete, true, 'tool guidance and runtime context stay enabled')

  const stages = [
    '# 1. Core Principles',
    '# 2. Workflow and Approval Boundaries',
    '# 3. Investigation and Concept Development',
    '# 4. Potential Future Features',
    '# 5. Implementation Planning',
    '# 6. Communication and Evidence',
  ]
  let previous = -1
  for (const heading of stages) {
    const at = prefix.indexOf(heading)
    assert.ok(at > previous, `prompt keeps the stage order at ${heading}`)
    previous = at
  }

  // Review and corrections were extracted into the reviewer preset.
  assert.ok(!prefix.includes('Implementation Review'), 'the architect prompt no longer reviews')
  assert.ok(!prefix.includes('Corrective Changes After Approval'), 'the architect prompt no longer corrects')

  const required = [
    'You are a technical architect.',
    'Backward compatibility is not a requirement.',
    'Do not introduce compatibility layers, deprecated alternative paths, temporary adapters, or duplicate implementations solely to preserve previous behavior.',
    'Explicitly document and obtain approval for destructive actions',
    'Do not automatically advance to the next stage.',
    'Never interpret approval for one stage as authorization for subsequent stages.',
    'Implementation and review belong to other agents',
    'Do not perform their stages.',
    'Do not produce a step-by-step implementation plan or modify implementation code during this stage.',
    'The plan is a static implementation contract, not an execution record.',
    '`Plan revision:` an integer starting at `1`.',
    'each with a stable identifier: `AC1`, `AC2`, and so on.',
    '`Produces:` the concrete outputs it delivers for dependent steps and for verification',
    'Connectivity to a single root is not required',
    'Before reporting the plan, validate it against this checklist',
    'Store these ideas in potential_future_features at the repository root.',
    'Another model performs the implementation.',
    'Do not expand scope in the name of clean architecture or future extensibility.',
  ]
  for (const sentence of required) {
    assert.ok(prefix.includes(sentence), `prompt keeps: ${sentence}`)
  }
})

test('the implementer preset composes the implementation toolset', () => {
  const implementer = declarations.find((declaration) => configOf(declaration).id === 'implementer')
  assert.ok(implementer, 'the implementer preset exists')

  assert.deepEqual(rowIds(implementer), [
    'persona',
    'agent-instructions',
    'time-context',
    'tool-bash',
    'tool-pwsh',
    'tool-fs',
    'tool-fs-search',
    'tool-jobs',
    'skill-filesystem',
    'tool-skill',
    'compaction',
    'tool-ask-user',
    'tool-todo',
    'tool-web',
  ])
})

test('the implementer preset deliberately omits unrelated capabilities', () => {
  const implementer = declarations.find((declaration) => configOf(declaration).id === 'implementer')
  const ids = rowIds(implementer)

  // The approved plan is the gate; plan mode would block the edits the role
  // exists to make and duplicate the tracker the progress file already is.
  for (const omitted of ['plan-mode', 'planning']) {
    assert.ok(!ids.includes(omitted), `implementer must not compose ${omitted}`)
  }
  // The preset executes the plan itself and keeps one execution record.
  for (const omitted of ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-workflow', 'workflow-ptc']) {
    assert.ok(!ids.includes(omitted), `implementer must not compose ${omitted}`)
  }
  // Continuations belong to the progress file, not to automatic rounds.
  for (const omitted of ['command-goal', 'tool-goal', 'tool-schedule']) {
    assert.ok(!ids.includes(omitted), `implementer must not compose ${omitted}`)
  }
  // The result is the repository change and the chat handoff report.
  assert.ok(!ids.includes('present'), 'implementer must not compose present')
})

test('the implementer preset gates one shell per platform and keeps compaction', () => {
  const implementer = declarations.find((declaration) => configOf(declaration).id === 'implementer')
  const byId = new Map(pluginsOf(implementer).map((plugin) => [plugin.id, plugin]))

  assert.equal(byId.get('tool-bash').disabled.__jsExpr, "process.platform === 'win32'")
  assert.equal(byId.get('tool-pwsh').disabled.__jsExpr, "process.platform !== 'win32'")

  const group = byId.get('compaction')
  assert.ok(group, 'the implementer preset mounts the compaction group')
  assert.deepEqual(group.isolate, { compaction: true, toolResultPruner: true })
  assert.deepEqual(
    group.config.map((plugin) => plugin.id),
    ['compaction-basic', 'command-compact', 'tool-result-pruner'],
  )
})

test('the implementer persona prompt is the complete execution contract', () => {
  const implementer = declarations.find((declaration) => configOf(declaration).id === 'implementer')
  const persona = pluginsOf(implementer).find((plugin) => plugin.id === 'persona')
  const prefix = persona.config.prefix

  assert.ok(!prefix.includes('\r'), 'the prompt stores LF line endings')
  assert.ok(!/[ \t]\n/.test(prefix), 'the prompt has no trailing whitespace')
  assert.ok(!/\{\{/.test(prefix), 'the prompt uses no unregistered template variables')
  assert.ok(prefix.endsWith('\n'), 'the prompt ends with a newline')
  assert.notEqual(persona.config.complete, true, 'tool guidance and runtime context stay enabled')

  const stages = [
    '# 1. Mission and Execution Authority',
    '# 2. Establish the Implementation Contract',
    '# 3. Scope Discipline',
    '# 4. Clean Implementation Without Legacy Compatibility',
    '# 5. Implementation Quality',
    '# 6. Persistent Progress File and Execution State',
    '# 7. Testing and Verification',
    '# 8. Repository and Operational Safety',
    '# 9. Blockers and Plan Deviations',
    '# 10. Completion and Handoff',
  ]
  let previous = -1
  for (const heading of stages) {
    const at = prefix.indexOf(heading)
    assert.ok(at > previous, `prompt keeps the stage order at ${heading}`)
    previous = at
  }

  const required = [
    'You are an implementation agent.',
    'Treat that plan as the implementation contract',
    'Do not stop after analysis, a proposed approach, an initial scaffold, or partial implementation.',
    'If the plan file cannot be identified or accessed, request it rather than inventing an implementation contract.',
    'Backward compatibility is not required unless the approved plan explicitly requires it.',
    'The plan is read-only for you: never edit it, annotate it, check off its steps, or record execution state in it.',
    'Before changing implementation code, create the persistent progress file for the entire approved plan.',
    'IMPLEMENTED: the required changes are present, but the entry\'s own verification is incomplete, not yet run, or not yet passing.',
    'VERIFIED: the changes are present, the entry\'s verification procedure has been executed, and its completion criteria are met with recorded evidence.',
    'When you pick up a leaf step or substep for work, set it IN_PROGRESS in the progress file before making its implementation changes.',
    'A leaf (a step without substeps, or a substep) is an executable work unit.',
    'keep exactly one leaf entry IN_PROGRESS at a time',
    'The per-entry `Status:` field is the single authoritative status of that step or substep',
    'its `Plan revision:`, and a checksum of the plan file at start',
    'A review correction round starts only when the user explicitly instructs you to apply corrections',
    'The review file is read-only for you: never edit it, mark findings corrected in it, or change its statuses.',
    'Never report an unexecuted check as passed.',
    'Do not weaken assertions, disable checks, delete relevant tests, or change expected results merely to obtain a passing result.',
    'Report only what the implementation and executed checks support.',
    'The result will be reviewed by another agent against the approved plan.',
  ]
  for (const sentence of required) {
    assert.ok(prefix.includes(sentence), `prompt keeps: ${sentence}`)
  }
})

test('the reviewer preset composes the review toolset with a writable review file', () => {
  const reviewer = declarations.find((declaration) => configOf(declaration).id === 'reviewer')
  assert.ok(reviewer, 'the reviewer preset exists')

  assert.deepEqual(rowIds(reviewer), [
    'persona',
    'agent-instructions',
    'time-context',
    'tool-bash',
    'tool-pwsh',
    'tool-fs',
    'tool-fs-search',
    'tool-jobs',
    'skill-filesystem',
    'tool-skill',
    'compaction',
    'tool-ask-user',
    'tool-todo',
    'tool-web',
  ])

  // Writing is enabled solely for the `[plan name].review.md` deliverable;
  // the persona contract forbids writing any other file.
  const files = pluginsOf(reviewer).find((plugin) => plugin.id === 'tool-fs')
  assert.deepEqual(files.config, { read: true, readImage: true, write: true, edit: true })
})

test('the reviewer preset deliberately omits unrelated capabilities', () => {
  const reviewer = declarations.find((declaration) => configOf(declaration).id === 'reviewer')
  const ids = rowIds(reviewer)

  // Review is the whole stage: the approved plan is the gate, and the report
  // ends the turn.
  for (const omitted of ['plan-mode', 'planning', 'command-goal', 'tool-goal', 'tool-schedule']) {
    assert.ok(!ids.includes(omitted), `reviewer must not compose ${omitted}`)
  }
  // Corrective changes belong to the implementation agent.
  for (const omitted of ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-workflow', 'workflow-ptc']) {
    assert.ok(!ids.includes(omitted), `reviewer must not compose ${omitted}`)
  }
  // The review file is written through tool-fs, not presented as a deliverable.
  assert.ok(!ids.includes('present'), 'reviewer must not compose present')
})

test('the reviewer preset gates one shell per platform and keeps compaction', () => {
  const reviewer = declarations.find((declaration) => configOf(declaration).id === 'reviewer')
  const byId = new Map(pluginsOf(reviewer).map((plugin) => [plugin.id, plugin]))

  assert.equal(byId.get('tool-bash').disabled.__jsExpr, "process.platform === 'win32'")
  assert.equal(byId.get('tool-pwsh').disabled.__jsExpr, "process.platform !== 'win32'")

  const group = byId.get('compaction')
  assert.ok(group, 'the reviewer preset mounts the compaction group')
  assert.deepEqual(group.isolate, { compaction: true, toolResultPruner: true })
  assert.deepEqual(
    group.config.map((plugin) => plugin.id),
    ['compaction-basic', 'command-compact', 'tool-result-pruner'],
  )
})

test('the reviewer persona prompt is the complete review contract', () => {
  const reviewer = declarations.find((declaration) => configOf(declaration).id === 'reviewer')
  const persona = pluginsOf(reviewer).find((plugin) => plugin.id === 'persona')
  const prefix = persona.config.prefix

  assert.ok(!prefix.includes('\r'), 'the prompt stores LF line endings')
  assert.ok(!/[ \t]\n/.test(prefix), 'the prompt has no trailing whitespace')
  assert.ok(!/\{\{/.test(prefix), 'the prompt uses no unregistered template variables')
  assert.ok(prefix.endsWith('\n'), 'the prompt ends with a newline')
  assert.notEqual(persona.config.complete, true, 'tool guidance and runtime context stay enabled')

  const stages = [
    '# 1. Review Authority and Boundaries',
    '# 2. Establish the Review Contract',
    '# 3. Verify the Implementation',
    '# 4. Checks and Evidence',
    '# 5. Review File, Statuses, and Findings',
    '# 6. Review Report',
    '# 7. Proposed Corrections',
    '# 8. Communication and Evidence',
  ]
  let previous = -1
  for (const heading of stages) {
    const at = prefix.indexOf(heading)
    assert.ok(at > previous, `prompt keeps the stage order at ${heading}`)
    previous = at
  }

  const required = [
    'You are a code reviewer.',
    'A request to review an implementation authorizes inspection, safe verification, and creating or updating the review file (`[plan name].review.md`), not corrective changes.',
    'Do not change implementation code during review, even when a fix appears obvious.',
    'The plan and the implementer\'s progress file are read-only for you: never edit them, annotate them, or record review state in them.',
    'Treat the progress file as the implementer\'s claim, not as proof',
    'they are applied by the implementation agent, not by you.',
    'If the change boundaries cannot be determined reliably from the recorded baseline, request a baseline commit, commit range, or another precise reference.',
    'Potential future features are not review requirements. Their absence is not a defect.',
    'Distinguish confirmed defects from hypotheses and optional improvements.',
    'Never claim to have inspected files or executed checks that you have not actually inspected or executed.',
    'Overall status: CONFORMS, PARTIALLY_CONFORMS, DOES_NOT_CONFORM, or INCONCLUSIVE.',
    'Determine the review type before reviewing individual items',
    '`Owner:` who must act on the finding',
    'ACCEPTED_DEVIATION, may be set only when the user explicitly instructs you to accept the deviation',
    'Item summary counts in the header are computed over leaf entries only',
    'The only path your review may have created or changed is the review file itself',
    'If issues are found, propose a specific set of corrective changes and request approval. Do not apply corrections before approval.',
    'Do not expand scope in the name of clean architecture or future extensibility.',
  ]
  for (const sentence of required) {
    assert.ok(prefix.includes(sentence), `prompt keeps: ${sentence}`)
  }
})

test('the three personas share one sequential plan/progress/review contract', () => {
  const personaOf = (id) => {
    const declaration = declarations.find((entry) => configOf(entry).id === id)
    assert.ok(declaration, `the ${id} preset exists`)
    return pluginsOf(declaration).find((plugin) => plugin.id === 'persona').config.prefix
  }
  const architect = personaOf('architect')
  const implementer = personaOf('implementer')
  const reviewer = personaOf('reviewer')
  const all = { architect, implementer, reviewer }

  // One artifact trio, derived from the plan file name, named identically by
  // every stage so a handoff never depends on chat history.
  for (const [id, prefix] of Object.entries(all)) {
    assert.ok(prefix.includes('[plan name].progress.md'), `${id} names the progress file`)
    assert.ok(prefix.includes('[plan name].review.md'), `${id} names the review file`)
    assert.ok(prefix.includes('Plan revision:'), `${id} binds work to a plan revision`)
    assert.ok(prefix.includes('handoff block'), `${id} ends its stage with a handoff block`)
  }

  // The architect's acceptance criteria identifiers are consumed downstream.
  assert.ok(architect.includes('`AC1`, `AC2`'), 'architect issues AC identifiers')
  assert.ok(implementer.includes('AC identifiers from the plan'), 'implementer records AC identifiers')
  assert.ok(reviewer.includes('`AC` identifiers'), 'reviewer reports against AC identifiers')

  // Leaf entries are the executable and countable units in both downstream
  // stages; parent steps are roll-ups.
  assert.ok(implementer.includes('is an executable work unit'), 'implementer defines leaf entries')
  assert.ok(reviewer.includes('computed over leaf entries only'), 'reviewer counts leaf entries only')

  // The progress status vocabulary the reviewer cross-checks is the one the
  // implementer writes.
  for (const status of ['TODO', 'IN_PROGRESS', 'IMPLEMENTED', 'VERIFIED', 'BLOCKED']) {
    assert.ok(implementer.includes(status), `implementer defines progress status ${status}`)
    assert.ok(reviewer.includes(status), `reviewer knows progress status ${status}`)
  }

  // The correction loop is closed on both sides: the reviewer routes
  // findings by owner, and the implementer executes approved findings
  // against a read-only review file.
  assert.ok(reviewer.includes('`Owner:`'), 'reviewer routes findings by owner')
  assert.ok(implementer.includes('## 9.1. Corrections from a Review'), 'implementer has a correction mode')
  assert.ok(implementer.includes('The review file is read-only for you'), 'implementer never edits the review file')
  assert.ok(reviewer.includes('CONFIRMED_CORRECTED'), 'reviewer confirms corrections in a later round')
})
