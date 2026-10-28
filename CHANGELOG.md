# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-29

### Added

- Sibling documents for the Architect → Implementer → Reviewer handoff: a plan
  named `YYYYMMDD-NN-slug.md` with a step/substep dependency graph, the
  implementer's `[plan name].progress.md` execution record, and the reviewer's
  `[plan name].review.md` review record.
- Implementer progress file: per-step and per-substep statuses with explicit
  transitions, parent-step roll-up, a status register, a resumption snapshot, a
  deviations and blockers log, and a final verification section.
- Reviewer review file: review rounds, an item review register, numbered findings
  with severities and statuses, a checks-and-evidence section, a progress-file
  assessment, dependency-ordered proposed corrections, and an overall status of
  CONFORMS, PARTIALLY_CONFORMS, DOES_NOT_CONFORM, or INCONCLUSIVE.

### Changed

- Architect planning starts only on the user's explicit request for the plan, and
  the plan is a directed acyclic graph: stable step identifiers, explicit
  `Depends on:` lines, one optional nested level of substeps, parallel execution
  levels, and an approximate `Estimated context:` (`S`, `M`, `L`) sized against
  a 128k–256k window. The plan records no execution state.
- Implementer treats the plan as read-only, executes the plan's graph rather than
  its listing order, and keeps execution state only in the progress file.
- Reviewer may create and update only its review file: `tool-fs` enables write
  and edit for it, the persona contract forbids every other change, and the
  implementer's progress file is treated as a claim to verify.

## [1.0.1] - 2026-10-28

### Changed

- Every preset persona prompt now carries one mandatory rule outside the role
  sections: never create, amend, or otherwise rewrite a git commit without an
  explicit user instruction to commit. Changes stay in the working tree until
  the user asks for a commit, and a finished plan or checklist does not
  authorize committing. `test/presets.test.mjs` enforces the rule for every
  preset in the bundle.

## [1.0.0] - 2026-10-26

### Added

- `architect` preset: a technical architect and code reviewer whose persona
  prompt defines two stages — investigation and concept development, and
  implementation planning — behind explicit approval boundaries.
- `implementer` preset: executes an approved implementation plan end to end,
  keeps a persistent checklist in a task-specific `docs` progress file, and
  verifies the result against the plan's acceptance criteria with an honest
  handoff report.
- `reviewer` preset: reviews an implementation against the approved plan and
  the concept it references, verifies the plan's acceptance criteria, and
  reports findings by severity for another model to correct.
- Role toolsets for the presets: repository instructions, platform-gated shell,
  files and search, background jobs, skills, head/tail compaction with a
  tool-result pruner, focused questions, todos, web access, and deliverables;
  the reviewer registers no write or edit tools. Deliberate omissions (plan
  mode, goals, schedules, delegation, `present`, Cordis and plugin-manager
  tools) are documented in the README.
- Optional per-preset model routes: the `dev-presets-model` Host plugin applies
  a configured provider, model, and reasoning effort when a session switches to
  that preset and when a session is created on it, and still routes the first
  model request as a fallback. An explicit composer or `/model` choice wins
  afterwards, resumed and subagent sessions keep their own route, and the
  deployment default model is never rewritten by the preset switch.
- **Settings → Development Presets**: a page listing the deployment's live model
  catalog over the authenticated `/dev-presets/models` route and saving the
  volatile route map without a restart; the same map can be written in the
  profile patch layer.
- Preset bundle layout: one `presets/<id>.patch.yml` declaration per role,
  listed in `dsh.bundle.patch`; a small Host plugin and its browser half for the
  optional model routes.
- Localized bundle metadata (English, Russian) and an original icon.
- `node:test` suites: declaration structure, role contracts, packaging, display
  metadata, documentation checks, model-catalog and route wiring, preset-switch
  and creation-time selection, and request-listener fallbacks.
- GitHub Actions CI on Linux and Windows with Node.js 20, 22, and 24.
- Documentation in English and Russian, contribution guide, Apache-2.0 license.

[1.1.0]: https://github.com/WatchDG/dsh-dev-presets/releases/tag/v1.1.0
[1.0.1]: https://github.com/WatchDG/dsh-dev-presets/releases/tag/v1.0.1
[1.0.0]: https://github.com/WatchDG/dsh-dev-presets/releases/tag/v1.0.0
