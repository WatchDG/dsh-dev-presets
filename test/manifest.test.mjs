// Packaging and display-metadata checks for the preset bundle.
//
// The bundle ships the YAML preset declarations in presets/, one Host plugin
// for optional per-preset model routes (index.js + lib/), its Configure-page
// browser half (client.js), and the display resources the Plugin Manager reads
// without activating anything.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const pkg = JSON.parse(read('package.json'))

const REQUIRED_FILES = [
  'index.js',
  'client.js',
  'lib/config.js',
  'lib/routes.js',
  'lib/catalog.js',
  'lib/plugin.js',
  'cordis.patch.yml',
  'presets/architect.patch.yml',
  'presets/implementer.patch.yml',
  'presets/reviewer.patch.yml',
  'locale/en.json',
  'locale/ru.json',
  'icon.svg',
  'README.md',
  'README.ru.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'NOTICE',
  'LICENSE',
  '.editorconfig',
  '.gitignore',
  '.gitattributes',
]

const patchPaths = () => pkg.dsh.bundle.patch.map((relative) => relative.replace(/^\.\//, ''))

test('manifest declares a DSH bundle', () => {
  assert.equal(pkg.name, 'dsh-dev-presets')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.license, 'Apache-2.0')
  assert.equal(pkg.main, 'index.js')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(Array.isArray(pkg.dsh.bundle.patch), 'the bundle lists its patch files')
  assert.ok(pkg.dsh.bundle.patch.length > 0, 'the bundle lists at least one patch file')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'),
    'the configure page needs the settings client services',
  )
})

test('the bundle patch list and presets/ directory agree', () => {
  const listed = patchPaths().sort()
  const presetPatches = listed.filter((relative) => relative.startsWith('presets/'))
  const onDisk = readdirSync(path.join(root, 'presets'))
    .filter((entry) => entry.endsWith('.patch.yml'))
    .map((entry) => `presets/${entry}`)
    .sort()

  assert.deepEqual(presetPatches, onDisk, 'every preset patch is listed in dsh.bundle.patch')
  assert.ok(listed.includes('cordis.patch.yml'), 'the bundle lists its Host plugin patch')
})

test('every shipped file is covered by the files array', () => {
  assert.ok(pkg.files.includes('index.js'))
  assert.ok(pkg.files.includes('client.js'))
  assert.ok(pkg.files.includes('lib/*.js'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
  assert.ok(pkg.files.includes('presets/*.patch.yml'))
  assert.ok(pkg.files.includes('locale/*.json'))
  assert.ok(pkg.files.includes('icon.svg'))
  assert.ok(pkg.files.includes('README.md'))
  assert.ok(pkg.files.includes('README.ru.md'))
  assert.ok(pkg.files.includes('CHANGELOG.md'))
  assert.ok(pkg.files.includes('CONTRIBUTING.md'))
  assert.ok(pkg.files.includes('NOTICE'))
  assert.ok(!pkg.files.includes('node_modules'), 'dependencies install from the registry')
  assert.ok(!pkg.files.some((entry) => entry.startsWith('test/')), 'tests are not shipped')
})

test('the only runtime dependency is the settings schema library', () => {
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@deepseek-ai/schemastery'])
  assert.ok(pkg.devDependencies.yaml, 'the test suite parses the preset YAML with yaml')
})

test('every required file exists', () => {
  for (const relative of REQUIRED_FILES) {
    assert.ok(statSync(path.join(root, relative)).isFile(), `${relative} is missing`)
  }
})

test('exports expose the Host plugin, the browser half, display metadata, and the icon', () => {
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./icon'], './icon.svg')
})

test('the Host plugin patch inserts the model-route row by package name', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /^-\s+insert:/m)
  assert.match(patch, /^\s+-\s+id:\s+dev-presets-model$/m)
  assert.match(patch, new RegExp(`^\\s+name:\\s+${pkg.name}$`, 'm'))

  const module = read('index.js')
  assert.match(module, /^export function apply\(ctx, config\)/m)
  assert.match(module, /^export const name = 'dev-presets-model'$/m)
})

test('the browser half registers the Settings section', () => {
  const client = read('client.js')
  assert.match(client, /^window\.__ModuleLoader__\.load\(\{/m)
  assert.match(client, new RegExp(`id: '${pkg.name}'`))
  assert.match(client, /'settings\.section'/)
  assert.match(client, /const SECTION_ID = 'dev-presets'/)
  assert.match(client, /configForms/)
  assert.ok(!client.includes('plugins.row.config'), 'the page lives in Settings, not on the Plugins row')
  assert.ok(!/\bdocument\.body\b/.test(client), 'the client half never appends to the document body')
})

test('the Host plugin entry point exports the plugin contract and its schema', async () => {
  const module = await import('../index.js')
  assert.equal(typeof module.apply, 'function')
  assert.equal(module.name, 'dev-presets-model')
  assert.equal(typeof module.Config, 'function')
})

test('locale resources carry display metadata', () => {
  for (const locale of ['en', 'ru']) {
    const meta = JSON.parse(read(`locale/${locale}.json`)).meta
    assert.equal(typeof meta.title, 'string', `${locale} title`)
    assert.ok(meta.title.length > 0, `${locale} title is empty`)
    assert.equal(typeof meta.description, 'string', `${locale} description`)
    assert.ok(meta.description.length > 0, `${locale} description is empty`)
  }
})

test('the icon is an SVG below the display size limit', () => {
  const icon = read('icon.svg')
  assert.match(icon, /^<svg[\s>]/, 'icon is an SVG document')
  assert.match(icon, /viewBox="0 0 64 64"/)
  assert.match(icon, /role="img"/)
  assert.ok(Buffer.byteLength(icon) < 256 * 1024, 'icon exceeds 256 KiB')
})

test('documentation links to DeepSeek Harness, names every preset, and documents the model setting', () => {
  for (const doc of ['README.md', 'README.ru.md']) {
    const text = read(doc)
    assert.match(text, /https:\/\/www\.deepseek\.com\/en\/harness\//, `${doc} links DeepSeek Harness`)
    assert.match(text, /Architect|«Архитектор»/, `${doc} names the Architect preset`)
    assert.match(text, /Implementer/, `${doc} names the Implementer preset`)
    assert.match(text, /Reviewer/, `${doc} names the Reviewer preset`)
    assert.match(text, /dev-presets-model/, `${doc} documents the per-preset model setting`)
    assert.match(text, /Development Presets|Пресеты разработки/, `${doc} documents the Settings section`)
  }
})

test('the changelog documents the current version', () => {
  assert.match(read('CHANGELOG.md'), new RegExp(`## \\[${pkg.version.replaceAll('.', '\\.')}\\]`))
})
