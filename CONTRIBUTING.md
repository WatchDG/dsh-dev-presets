# Contributing

Thanks for considering a contribution to `dsh-dev-presets`.

## Before you start

- Read the [README](README.md) to understand the bundle and its preset roles.
- The bundle targets [DeepSeek Harness](https://www.deepseek.com/en/harness/)
  0.2.x and uses the `@deepseek-ai/dsh-agent-preset` declaration format.
- The bundle ships YAML declarations plus one Host plugin that applies the
  optional per-preset model routes on preset switch, on session creation, and as
  a first-request fallback, plus its Settings-page browser half. Keep preset
  files free of deployment-specific models, and keep the route map editable only
  through the plugin's own Config schema.
- The Host plugin row (`dev-presets-model`) stays in `cordis.patch.yml`, its
  logic in `lib/`, its configuration schema volatile in `lib/config.js`, and
  the page in `client.js` as the `dev-presets` Settings section.

## Development

```bash
npm ci            # install the YAML parser used by the tests
npm test          # declaration, role-contract, packaging, and metadata checks
npm run pack:check # inspect the files npm would publish
```

Requirements: Node.js 20 or newer. There is no build step.

Run the tests before opening a pull request. CI runs them on Linux and Windows
with Node.js 20, 22, and 24.

## Adding a preset

1. Create `presets/<id>.patch.yml` with exactly one
   `@deepseek-ai/dsh-agent-preset` declaration (copy
   [`presets/architect.patch.yml`](presets/architect.patch.yml)).
2. Add the file path to `dsh.bundle.patch` in `package.json`.
3. Give the preset an `id`, a display `name`, a `description`, and a roster
   `order` that is unique in the bundle. The row id is `preset-<id>` by
   convention.
4. Update the preset table in `README.md` and `README.ru.md`, the locale
   description if the bundle's summary changed, and `CHANGELOG.md`.
5. Run `npm test`: the suite discovers the new file automatically.

A preset is a closed composition. Do not include a plugin that exists only to
support a possible future feature of the role, and do not duplicate a shipped
preset unless the role differs in identity or toolset.

## Bundle invariants

- `package.json` declares `dsh.bundle.patch` as an array and every entry exists
  under `presets/`. The manifest test fails when the list and the directory
  disagree.
- One file declares one preset row: `- insert:` with a single row whose `name`
  is `@deepseek-ai/dsh-agent-preset`.
- Preset ids are lowercase kebab-case equal to the file basename; row ids are
  `preset-<id>`; ids and orders are unique across the bundle.
- Every preset mounts exactly one `persona` row with a non-empty `prefix`. A
  persona prefix is a template that resolves `{{…}}` groups strictly at render
  time, so do not mention template syntax casually.
- Every persona prefix carries the bundle-wide mandatory rule outside the
  numbered role sections: the agent never creates, amends, or otherwise rewrites
  a commit without an explicit user instruction to commit, and leaves the
  changes in the working tree until asked. The rule is part of the role
  contract, not documentation.
- The three roles exchange sibling documents: the plan `[plan name].md` is a
  static contract with no execution state, the implementer's
  `[plan name].progress.md` holds execution state, and the reviewer's
  `[plan name].review.md` holds review state. Keep the file naming in the
  prompts, the tests, and both READMEs consistent.
- The reviewer's `tool-fs` row enables write and edit for its review file only,
  and the persona contract forbids every other write. Do not widen that scope
  without changing the contract and its tests.
- Keep both the POSIX and the Windows shell row in a preset that needs a shell,
  gated with `!!js process.platform === 'win32'` and
  `!!js process.platform !== 'win32'`, so the composition is portable.
- `!!js` expressions are Loader expressions, never `!js`.
- The Host plugin row (`dev-presets-model`) stays in `cordis.patch.yml`, its
  logic in `lib/`, and its route map is deployment configuration, never preset
  content.
- `locale/en.json` and `locale/ru.json` keep meaningful `meta.title` and
  `meta.description`; the icon stays a valid SVG below 256 KiB.
- Documentation links to https://www.deepseek.com/en/harness/.

## YAML style

- Two-space indentation, LF line endings, no trailing whitespace.
- One space after `:`; quote the plugin package specifiers (`'@deepseek-ai/…'`).
- Comments explain a design decision or a contract; do not narrate obvious
  YAML.
- Keep the persona prompt as a literal block scalar (`|`) so it round-trips
  exactly; do not fold or rewrap it.

## Reporting issues

Open an issue at https://github.com/WatchDG/dsh-dev-presets/issues with the DSH
version, the selected preset, the session mode, and the relevant prompt or
transcript excerpt.

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0, as described in [LICENSE](LICENSE).
