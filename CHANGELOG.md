# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/WatchDG/dsh-dev-presets/releases/tag/v1.0.0
