# dsh-dev-presets

[![CI](https://github.com/WatchDG/dsh-dev-presets/actions/workflows/ci.yml/badge.svg)](https://github.com/WatchDG/dsh-dev-presets/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**English** | [Русский](README.ru.md)

Development-role agent presets for [DeepSeek Harness](https://www.deepseek.com/en/harness/).
A preset is a declarative composition of Harness plugins: it gives a session its
identity prompt, toolset, prompt sections, and context. This bundle ships one
preset per development role, each in its own file under `presets/`, and the
preset is selected per session from the Web roster.

The bundle ships three presets:

| Preset | Roster name | Order | Role |
|---|---|---|---|
| [`architect`](presets/architect.patch.yml) | Architect | 10 | Investigates a task, documents a concept and an implementation plan for another model, and advances only on explicit user approval |
| [`implementer`](presets/implementer.patch.yml) | Implementer | 11 | Executes an approved implementation plan end to end — implementation, consumers, tests, documentation, and verification against the plan's acceptance criteria |
| [`reviewer`](presets/reviewer.patch.yml) | Reviewer | 12 | Reviews an implementation against the approved plan and concept, verifies acceptance criteria, and reports findings for another model to correct |

## The Architect preset

The Architect is a technical architect. Its work is split into two stages that
never advance automatically:

1. **Investigation and concept development** — inspect the repository, read its
   documentation, examine implementation and tests, and write a concept
   document under `docs`.
2. **Implementation planning** — after the concept is approved, write a
   self-contained plan that another model implements.

Review and execution are separate presets: the **Reviewer** checks an
implementation against the approved plan and concept, and the **Implementer**
executes the plan and applies approved corrections.

The persona prompt is the process contract: a request for one stage authorizes
that stage only, and the agent stops after each stage and waits for the user.
That contract also covers the repository conventions the role must follow —
documentation structure, `potential_future_features` entries, change boundaries,
and evidence for every claim.

### Toolset

| Capability | Composed rows |
|---|---|
| Identity | `persona` with the architect prompt |
| Repository conventions | `agent-instructions` reads `AGENTS.md` and compatible instruction files (64 KiB) |
| Terminal | `tool-pwsh` on Windows, `tool-bash` elsewhere; exactly one is enabled |
| Files | `tool-fs` (read, write, edit, images) and `tool-fs-search` (`glob`, `grep`) |
| Background work | `tool-jobs` for long builds and test suites |
| Skills | `skill-filesystem` and `tool-skill` (project `.dsh/skills` and `.agents/skills`, custom, user roots) |
| Long sessions | `compaction-basic`, `/compact` via `command-compact`, and `tool-result-pruner` |
| Human interaction | `tool-ask-user` for focused questions, `tool-todo` for stage work |
| External references | `tool-web` (search and fetch) |
| Deliverables | `present` |
| Context | `time-context` |

### Deliberate omissions

The preset composes only what the role needs; the excluded capabilities are
part of the design, not an oversight:

| Omitted | Why |
|---|---|
| Web plan mode (`dsh-plan-mode`, `exit_plan_mode`) | Stage approval is this preset's own gate. Plan mode forbids the concept-stage documentation writes the role must perform and adds a second, competing approval channel. |
| Goals (`command-goal`, `tool-goal`) | Goals continue the session across automatic rounds, which contradicts the requirement to stop after each stage and wait for the user. |
| Schedules (`tool-schedule`) | No part of the role is time-driven. |
| Delegation (`subagent*`, `workflow*`) | Implementation and review belong to the Implementer and Reviewer presets under explicit user control. The architect spawning agents itself would bypass the stage boundary. |
| Cordis and plugin-manager tools | The role produces documentation and plans; it does not compose the Harness profile. |

## The Implementer preset

The Implementer executes an approved implementation plan in the current
repository. The plan given by the user is the implementation contract; it
bounds the work together with explicit user instructions and the approved
concept the plan references.

Its persona prompt requires it to:

- establish the contract before editing code — read the plan and the concept it
  references, inspect repository instructions, implementation, tests, and build
  configuration, and identify pre-existing working-tree changes;
- keep a persistent execution checklist in a task-specific Markdown progress
  file under `docs`, with stable work-item identifiers, dependencies,
  completion conditions, and the statuses TODO, IN_PROGRESS, IMPLEMENTED,
  VERIFIED, and BLOCKED;
- execute the checklist and update it after each meaningful work item, keeping
  implementation and verification states distinct;
- implement the entire plan: code, integration, consumer and contract updates,
  removal of replaced paths, tests, and documentation;
- verify against the plan's acceptance criteria with the repository's own
  checks, and distinguish checks that ran from checks that could not run;
- report completion honestly: implemented-but-unverified and blocked items are
  called out, never reported as passed.

It implements the approved task and nothing beyond it, does not preserve legacy
compatibility unless the plan requires it, and does not expand scope in the
name of clean architecture.

### Toolset

| Capability | Composed rows |
|---|---|
| Identity | `persona` with the implementer prompt |
| Repository conventions | `agent-instructions` reads `AGENTS.md` and compatible instruction files (64 KiB) |
| Terminal | `tool-pwsh` on Windows, `tool-bash` elsewhere; exactly one is enabled |
| Files | `tool-fs` (read, write, edit, images) and `tool-fs-search` (`glob`, `grep`) |
| Background work | `tool-jobs` for long builds and test suites |
| Skills | `skill-filesystem` and `tool-skill` (project `.dsh/skills` and `.agents/skills`, custom, user roots) |
| Long sessions | `compaction-basic`, `/compact` via `command-compact`, and `tool-result-pruner` |
| Human interaction | `tool-ask-user` for genuine blockers, `tool-todo` for the working set |
| External references | `tool-web` (search and fetch) |
| Context | `time-context` |

The progress file is ordinary repository content, so the preset needs no
dedicated tracker tool beyond the files and terminal rows above.

### Deliberate omissions

| Omitted | Why |
|---|---|
| Web plan mode (`dsh-plan-mode`, `exit_plan_mode`) | The plan is already approved and the progress file is the execution tracker. Plan mode would forbid the implementation edits the role exists to make. |
| Goals (`command-goal`, `tool-goal`) | The execution contract is bounded by the approved plan and continuations belong to the progress file, not to automatic goal rounds. |
| Schedules (`tool-schedule`) | No part of the role is time-driven. |
| Delegation (`subagent*`, `workflow*`) | The preset executes the plan itself and keeps one execution record; delegating fragments that record. |
| `present` | The result is the repository change and the chat handoff report, not a standalone deliverable file. |
| Cordis and plugin-manager tools | The role implements the plan; it does not compose the Harness profile. |

## The Reviewer preset

The Reviewer checks an implementation against the approved plan and the concept
it references, verifies the plan's acceptance criteria, and reports findings for
another model to correct. It is the review stage of the workflow; the
Implementer applies corrections after approval.

Its persona prompt requires it to:

- establish the review contract first: the task, concept, and plan; the changes
  belonging to the implementation; and the baseline to compare against,
  including pre-existing uncommitted changes;
- inspect both the diff and the surrounding context — related contracts,
  callers, tests, and documentation — and request a baseline commit or commit
  range when the change boundaries are unclear;
- verify every plan item and acceptance criterion, behavioral correctness and
  error handling, edge cases, integration, test coverage, unrequested
  functionality, removal of obsolete paths, unjustified complexity, and
  documentation consistency;
- run only safe local checks, distinguish confirmed defects from hypotheses, and
  record checks that could not be performed;
- deliver a report with the overall status, item statuses, findings ordered by
  severity, and location, issue, impact, and proposed correction per finding;
- propose a concrete set of corrective changes and request approval, then stop —
  without applying corrections.

### Toolset

| Capability | Composed rows |
|---|---|
| Identity | `persona` with the reviewer prompt |
| Repository conventions | `agent-instructions` reads `AGENTS.md` and compatible instruction files (64 KiB) |
| Terminal | `tool-pwsh` on Windows, `tool-bash` elsewhere; exactly one is enabled, for diffs, history, and safe checks |
| Files (inspection only) | `tool-fs` with `write: false` and `edit: false`: the write and edit tools are never registered |
| Search | `tool-fs-search` (`glob`, `grep`) |
| Background work | `tool-jobs` for long builds and test suites |
| Skills | `skill-filesystem` and `tool-skill` (project `.dsh/skills` and `.agents/skills`, custom, user roots) |
| Long sessions | `compaction-basic`, `/compact` via `command-compact`, and `tool-result-pruner` |
| Human interaction | `tool-ask-user` for baseline and scope questions, `tool-todo` for the finding set |
| External references | `tool-web` (search and fetch) |
| Context | `time-context` |

The read-only file configuration is the one place where a preset enforces its
contract technically instead of relying on the persona alone.

### Deliberate omissions

| Omitted | Why |
|---|---|
| Write and edit file tools | Review ends with a report and a proposed correction set; the Implementer applies approved corrections. `tool-fs` registers neither tool. |
| Web plan mode (`dsh-plan-mode`, `exit_plan_mode`) | Review is read-only by construction and the persona defines the stop-and-approve boundary; a mode gate would add a second approval channel. |
| Goals (`command-goal`, `tool-goal`) | The review report ends the stage; automatic continuation rounds would outlive the request. |
| Schedules (`tool-schedule`) | No part of the role is time-driven. |
| Delegation (`subagent*`, `workflow*`) | Reviewing is this preset's own work; delegation would split the verification record. |
| `present` | The review report is chat output, not a standalone deliverable file. |
| Cordis and plugin-manager tools | The role reviews repository changes; it does not compose the Harness profile. |

## Default model per preset

A preset declaration cannot carry a model: DSH starts a session on the model
recorded in its log or on the deployment default (`agent-default-model`). The
bundle ships one small Host plugin (`dev-presets-model`) that closes that gap
when a deployment wants it: switching a session that has not yet logged a model
request — including the current blank session — to a configured preset applies
that preset's provider and model as the session's model selection, the same
Session-local mechanism a composer choice uses. The composer therefore shows the
preset model immediately, and the deployment default model is not rewritten.

The routes are edited in **Settings → Development Presets**. The page lists the
deployment's live model catalog — provider, model, and reasoning effort per
preset — and saves through the settings service, so a change applies without a
restart. The shipped map is empty, so the plugin stays inert until configured.

The same map can be written in the profile patch layer, next to the
deployment's own model catalog:

```yaml
- id: dev-presets-model
  name: dsh-dev-presets
  config:
    presets:
      architect:
        provider: opencode-live
        model: deepseek-v4-pro
        reasoningEffort: high
      implementer:
        provider: opencode-live
        model: deepseek-v4.1-flash
      reviewer:
        provider: opencode-live
        model: deepseek-v4-pro
```

Behavior:

- Switching a session that has not yet logged a model request — including the
  current blank session — to a configured preset applies the route as the
  session's model selection: the composer's model seat shows the preset model
  immediately, and the deployment default model stays unchanged.
- A session created on a configured preset starts on the preset model, first
  prompt included. A preset without a route leaves the current model untouched.
- An explicit choice in the composer or `/model` still wins and behaves exactly
  like a normal model selection, so it also saves the default model as DSH
  normally does; the preset route is not reapplied after it.
- Resumed sessions, subagent sessions, and sessions that already recorded a
  request keep the route logged in their log.
- First-request routing remains as a fallback when the session controller cannot
  apply a selection; an explicit model choice still wins there too.
- An unknown or unavailable route logs a warning and the current model is kept.
- The Settings page writes the map live; a profile-patch change is read when
  the profile recomposes. A row override replaces the complete `config`;
  restate the whole `presets` map.

## Requirements

| Requirement | Details |
|---|---|
| [DeepSeek Harness](https://www.deepseek.com/en/harness/) | 0.2.x (tested with 0.2.1). The bundle uses the `@deepseek-ai/dsh-agent-preset` registry and the shipped preset plugins; it needs no external binaries. |
| Node.js | 20 or newer, for the test suite. The Host plugin runs inside the Harness process. |

The Host plugin's only runtime dependency is `@deepseek-ai/schemastery`, the
settings schema library; installing the bundle installs it.

The bundle assumes the shipped Web bundle (`@deepseek-ai/dsh-web-app`) is
active, because that is where the preset declarations are rendered into the
session roster.

## Installation in DeepSeek Harness

The bundle applies to the current DSH profile and appears in the Plugin
Manager. Its presets are available to sessions created after installation.

1. Open the **Plugins** page in the DSH sidebar (the Plugin Manager).
2. Choose **Add plugin** / **Install bundle**, select this directory (the one
   containing `package.json`), and confirm.
3. Make sure **Development Presets** is enabled in the plugin list.
4. Create a new session and choose **Architect**, **Implementer**, or
   **Reviewer** in its preset selector.

An agent can perform the same step through the `plugin_manager` tool with
`action: install_bundle` and the absolute path to this directory. DSH records a
`link:` dependency on the directory, so restart DSH after editing a preset file
to load the new declaration.

To uninstall, remove the bundle from the Plugin Manager
(`plugin_manager` `action: remove_bundle`). Sessions that already selected one
of the presets keep the composition they started with until the process
restarts; after removal, new sessions cannot select the presets and resuming an
old session that requests one fails.

## Configuration

A preset is a YAML declaration, never a JavaScript plugin. There are two ways
to change it:

- **Edit this bundle.** Change the preset file under `presets/` and restart DSH.
  This is the way to change the shipped preset for every profile that links this
  directory.
- **Override the row in the profile patch layer.** The declaration row ids are
  `preset-architect`, `preset-implementer`, and `preset-reviewer`, so a profile
  patch can target them:

  ```yaml
  - id: preset-reviewer
    name: '@deepseek-ai/dsh-agent-preset'
    config:
      id: reviewer
      name: Reviewer
      description: Your description.
      order: 12
      plugins: []   # the complete child list; a row override never deep-merges
  ```

  A row override replaces the complete `config`, so restate `id`, `name`,
  `description`, `order`, and the full `plugins` list.

Preset declarations load eagerly and are shared by the sessions that select
them. Editing a declaration affects subsequently created sessions; a live
session keeps the composition it started with.

## Verification

1. The **Plugins** page shows **Development Presets** with its description and
   icon, enabled.
2. A new session's preset selector offers **Architect**, **Implementer**, and
   **Reviewer** after the four shipped presets (roster orders 10, 11, 12).
3. In an Architect session, ask the agent to state its role and current stage:
   it should describe the two-stage workflow and its approval boundaries.
4. Give the Architect an imperative implementation request. It should
   investigate and produce a concept document under `docs` instead of changing
   implementation code, then stop for approval.
5. In an Implementer session, point it at a plan document: it should create the
   progress file under `docs`, implement the plan, run the plan's checks, and
   report each item as implemented, verified, blocked, or unverified.
6. In a Reviewer session, point it at a plan and an implementation range: it
   should report findings by severity with proposed corrections and must not
   edit files — the write and edit tools are not registered for this preset.
7. Open **Settings → Development Presets**: the page lists providers, models,
   and efforts from the live catalog, and a saved route applies to new sessions
   without a restart.
8. Select that preset in a blank session: the composer's model seat shows the
   configured provider and model immediately, and the Host log prints
   `dev-presets: preset "<id>" switches session "<sessionId>" to <provider>/<model>`.
   A later composer or `/model` choice overrides it normally and wins.
9. `npm test` passes in a checkout of this repository.

## Development

```bash
npm ci            # install the YAML parser used by the tests
npm test          # declaration, role-contract, packaging, and metadata checks
npm run pack:check # verify the npm package contents
```

Requirements: Node.js 20 or newer. There is no build step and no runtime
dependency.

Layout:

```
index.js                      Host plugin entry: apply + Config export
client.js                     Settings → Development Presets section for the routes
lib/config.js                 Volatile route-map schema and live snapshot helpers
lib/catalog.js                Browser model-catalog payload from the LLM registry
lib/routes.js                 Route validation, preset lookup, call-config rewrite
lib/plugin.js                 preset/model wiring, catalog route, settings policy
cordis.patch.yml              bundle patch inserting the Host plugin row
presets/architect.patch.yml   Architect declaration: persona prompt + concept/planning toolset
presets/implementer.patch.yml Implementer declaration: persona prompt + execution toolset
presets/reviewer.patch.yml    Reviewer declaration: persona prompt + read-only review toolset
presets/                      one file per preset role
locale/en.json                Plugin Manager title and description (English)
locale/ru.json                Plugin Manager title and description (Russian)
test/manifest.test.mjs        packaging and display-resource checks
test/presets.test.mjs         declaration and role-contract checks
test/preset-model.test.mjs    config, catalog, route validation, selection and request wiring checks
package.json                  bundle manifest; dsh.bundle.patch lists cordis.patch.yml and presets/*.patch.yml
```

Adding another role means adding one `presets/<id>.patch.yml` file and its path
to `dsh.bundle.patch`; the test suite picks the file up automatically. Keep
preset ids and roster orders unique. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security and privacy

- The bundle ships YAML declarations plus one Host plugin (`index.js`, `lib/`)
  and its browser half (`client.js`) for the optional per-preset model routes.
  The plugin runs in the Host process, makes no network access, and collects no
  telemetry: it reads the session preset and model-selection projections, and
  applies a configured route to the session's model selection on preset switch
  or creation — or to the first request as a fallback — only when a route is
  configured.
- Composing a preset mounts the Harness plugins listed in its declaration. Those
  are shipped Harness packages, not code from this repository. The Host plugin
  resolves a configured route through the Harness `llm` service and never reads
  credentials itself; an unavailable route keeps the current model.
- The Settings page reads model metadata from the Host's authenticated
  `/dev-presets/models` route and writes through the Settings service; that
  route serves provider, model, and reasoning metadata only, never credentials.
- A preset is a composition, not a security sandbox: its YAML and the plugins it
  mounts can execute Host code. The approval boundaries and scope rules in the
  preset prompts are instructions to the model, not a technical enforcement
  layer. Use session approval settings for enforcement; the reviewer's
  read-only `tool-fs` config is the only tool-level restriction in this bundle.

## Links

- **DeepSeek Harness** — https://www.deepseek.com/en/harness/
- **Plugin repository** — https://github.com/WatchDG/dsh-dev-presets

## License

[Apache-2.0](LICENSE), © 2026 Baranov Grigoriy Vladimirovich.
