// Model-route plugin: config schema and live snapshot, catalog building,
// preset-switch and creation-time selection through the Agent's own durable
// model selection. No Harness is required: the tests use a fake context that
// records listeners and serves the optional services.
//
// The fake mirrors the DSH 0.2.2 plugin contracts the plugin is written
// against: `agent.model.select()` appends the Session's `model/selection`
// event, `agentPresets.presetForSession()` reads the committed preset, and
// `sessionProjections.snapshot(session, keys)` returns the client-visible
// `{ lastUsed, next }` view of the model selection.
import test from 'node:test'
import assert from 'node:assert/strict'

import { Config, snapshot } from '../lib/config.js'
import { buildModelCatalog } from '../lib/catalog.js'
import { isRootSession, mount, MODELS_PATH } from '../lib/plugin.js'
import { normalizeRoutes, routeForPreset, sameSelection } from '../lib/routes.js'

/**
 * Fake Host context: records listeners by event name, resolves optional
 * services by name, collects the model selections the plugin commits, and
 * collects route registrations inside a fake child context.
 *
 * @param {{
 *   preset?: string | null,
 *   header?: object,
 *   requestHeader?: object,
 *   modelSelection?: { lastUsed?: object | null, pending?: object | null },
 *   llm?: object,
 *   agentDefaultModel?: object,
 *   liveAgents?: boolean,
 *   withModel?: boolean,
 *   withInjection?: boolean,
 *   selectThrows?: boolean,
 * }} [options]
 */
function createContext({
  preset = 'architect',
  header = {},
  requestHeader,
  modelSelection,
  llm,
  agentDefaultModel,
  liveAgents = true,
  withModel = true,
  withInjection = false,
  selectThrows = false,
} = {}) {
  const listeners = new Map()
  const routes = []
  const warnings = []
  const infos = []
  const selections = []
  const settingsPolicies = []
  const state = {
    lastUsed: modelSelection?.lastUsed ?? null,
    pending: modelSelection?.pending ?? null,
  }

  const agent = {
    id: 'session-1',
    session: {
      id: 'session-1',
      header,
      requestHeader: () => requestHeader,
    },
    ...(withModel
      ? {
          model: {
            select: (selection) => {
              if (selectThrows) throw new Error('the session writer is held')
              selections.push(selection)
              state.pending = selection
            },
            current: () => state.pending ?? state.lastUsed,
          },
        }
      : {}),
  }

  /** A composer or `/model` choice: committed like the Agent's own selection. */
  const chooseModel = (selection) => {
    state.pending = selection
  }

  const presets = {
    presetForSession: (session) => (session === agent.session ? preset : null),
  }

  const projections = {
    snapshot: (session, keys) => {
      const values = {}
      if (session !== agent.session) return { values }
      if (keys === undefined || keys.includes('agentPreset')) values.agentPreset = preset
      if (keys === undefined || keys.includes('modelSelection')) {
        values.modelSelection = { lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed }
      }
      return { values }
    },
  }

  const ctx = {
    fiber: {},
    on: (name, listener) => {
      const registered = listeners.get(name) ?? []
      registered.push(listener)
      listeners.set(name, registered)
      return () => {
        listeners.set(name, registered.filter((entry) => entry !== listener))
      }
    },
    get: (name) => {
      if (name === 'sessionProjections') return projections
      if (name === 'agentPresets') return presets
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return agentDefaultModel
      if (name === 'agents') {
        return { get: (id) => (liveAgents && id === agent.id ? agent : undefined) }
      }
      return undefined
    },
    logger: {
      warn: (message) => warnings.push(message),
      info: (message) => infos.push(message),
    },
  }
  if (withInjection) {
    ctx.inject = (deps, callback) => {
      const child = {
        connection: { requestRejection: () => undefined },
        webServer: {
          register: (route) => {
            routes.push(route)
            return () => {}
          },
        },
        settings: {
          configure: (policy, owner) => {
            settingsPolicies.push({ policy, owner })
            return () => {}
          },
        },
        effect: (factory) => {
          factory()
          return () => {}
        },
        get: ctx.get,
      }
      callback(child)
      return () => {}
    }
  }

  /**
   * Dispatch one recorded event to every listener, awaiting their returns.
   *
   * @param {string} name Event name.
   * @param {...unknown} args Event arguments.
   * @returns {Promise<void>} settlement of the synchronous listeners.
   */
  const emit = async (name, ...args) => {
    for (const listener of listeners.get(name) ?? []) await listener(...args)
  }

  return {
    ctx,
    agent,
    listeners,
    routes,
    warnings,
    infos,
    selections,
    settingsPolicies,
    state,
    chooseModel,
    emit,
  }
}

/** Let pending promise chains run to completion. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Fake LLM service over a fixed provider/model table. */
function createLlm({ failing = [], deferred = false } = {}) {
  const providers = [
    { id: 'opencode-live', name: 'OpenCode' },
    { id: 'pi-ai', name: 'Pi AI' },
  ]
  /** Deferred `resolveCallConfig` calls, resolved by the test. */
  const pending = []
  return {
    pending,
    listProviders: () => providers,
    listModels: async (provider) => {
      if (failing.includes(provider)) throw new Error(`provider ${provider} is down`)
      if (provider === 'opencode-live') {
        return [
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
          { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
        ]
      }
      return [{ id: 'mercury-3', name: 'Mercury 3' }]
    },
    resolveModelInfo: async (provider, model) => {
      if (provider === 'opencode-live' && model === 'deepseek-v4-pro') {
        return {
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
            ],
            defaultEffort: 'high',
          },
        }
      }
      return {}
    },
    resolveCallConfig: (config) => {
      if (!deferred) return Promise.resolve({ ...config, reasoningEffort: 'high' })
      return new Promise((resolve, reject) => {
        pending.push({ config, resolve, reject })
      })
    },
  }
}

/** A plain Config value as the tests pass it (no volatile references). */
const CONFIG = { presets: { architect: { provider: 'opencode-live', model: 'deepseek-v4-pro' } } }
const TWO_ROUTES = {
  presets: {
    architect: { provider: 'opencode-live', model: 'deepseek-v4-pro' },
    implementer: { provider: 'opencode-live', model: 'deepseek-v4.1-flash' },
  },
}

test('routes are normalized from the raw config map', () => {
  assert.deepEqual(normalizeRoutes(undefined), {})
  assert.deepEqual(normalizeRoutes(null), {})
  assert.deepEqual(normalizeRoutes({ architect: { provider: 'p', model: 'm' } }), {
    architect: { provider: 'p', model: 'm' },
  })
  assert.deepEqual(normalizeRoutes({ architect: { provider: 'p' } }), {}, 'a half route is dropped')
  assert.deepEqual(normalizeRoutes({ architect: { model: 'm' } }), {}, 'a half route is dropped')
  assert.deepEqual(normalizeRoutes({ architect: 'p/m' }), {}, 'a non-object entry is dropped')
  assert.deepEqual(
    normalizeRoutes({ architect: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    { architect: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
  )
  assert.deepEqual(
    normalizeRoutes({ architect: { provider: 'p', model: 'm', reasoningEffort: '' } }),
    { architect: { provider: 'p', model: 'm' } },
    'an empty effort is not a route field',
  )
})

test('a route is found only for an exact configured preset', () => {
  const routes = normalizeRoutes(TWO_ROUTES.presets)
  assert.deepEqual(routeForPreset(routes, 'architect'), {
    provider: 'opencode-live',
    model: 'deepseek-v4-pro',
  })
  assert.equal(routeForPreset(routes, 'reviewer'), undefined)
  assert.equal(routeForPreset(routes, undefined), undefined)
  assert.equal(routeForPreset(routes, ''), undefined)
  assert.equal(routeForPreset(routes, 'constructor'), undefined, 'inherited keys are not presets')
})

test('selections are compared by provider, model, and effort', () => {
  assert.equal(sameSelection(null, null), true)
  assert.equal(sameSelection(undefined, undefined), true)
  assert.equal(sameSelection(null, { provider: 'p', model: 'm' }), false)
  assert.equal(sameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }), true)
  assert.equal(sameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'n' }), false)
  assert.equal(sameSelection({ provider: 'p', model: 'm' }, { provider: 'q', model: 'm' }), false)
  assert.equal(
    sameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm', reasoningEffort: 'high' }),
    false,
    'an absent effort is its own value',
  )
  assert.equal(
    sameSelection(
      { provider: 'p', model: 'm', reasoningEffort: 'high' },
      { provider: 'p', model: 'm', reasoningEffort: 'high' },
    ),
    true,
  )
})

test('the config schema accepts an empty map and volatile writes', () => {
  const parsed = Config({})
  assert.deepEqual({ ...parsed, presets: parsed.presets.get() }, { presets: {} })

  const written = { architect: { provider: 'p', model: 'm', reasoningEffort: 'high' } }
  assert.deepEqual(Config({ presets: written }).presets.get(), written)
  assert.throws(
    () => Config({ presets: { architect: { provider: 'p' } } }),
    'a route without a model is rejected',
  )
})

test('the live snapshot unwraps volatile references and tolerates plain values', () => {
  assert.deepEqual(snapshot({ presets: { architect: { provider: 'p', model: 'm' } } }), {
    presets: { architect: { provider: 'p', model: 'm' } },
  })
  assert.deepEqual(snapshot({}), { presets: {} })
  assert.deepEqual(snapshot(undefined), { presets: {} })
  assert.deepEqual(snapshot({ presets: null }), { presets: {} })
  assert.deepEqual(
    snapshot({ presets: { get: () => ({ architect: { provider: 'p', model: 'm' } }) } }),
    { presets: { architect: { provider: 'p', model: 'm' } } },
    'a volatile reference is read at use time',
  )
  assert.deepEqual(
    snapshot({ presets: { get: () => undefined } }),
    { presets: {} },
    'an empty volatile reference falls back',
  )
})

test('the model catalog groups providers and isolates failures', async () => {
  const { ctx } = createContext({ llm: createLlm({ failing: ['pi-ai'] }) })
  const catalog = await buildModelCatalog(ctx)

  assert.equal(catalog.groups.length, 1)
  assert.equal(catalog.groups[0].id, 'opencode-live')
  assert.deepEqual(catalog.routableProviders, ['opencode-live'])
  assert.deepEqual(
    catalog.groups[0].models.map((model) => model.id),
    ['deepseek-v4-pro', 'deepseek-v4.1-flash'],
  )
  assert.deepEqual(catalog.groups[0].models[0].reasoning, {
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'high',
  })
  assert.deepEqual(catalog.failures, [{ id: 'pi-ai', name: 'Pi AI', message: 'provider pi-ai is down' }])
})

test('the model catalog reports the deployment default', async () => {
  const selection = { provider: 'opencode-live', model: 'deepseek-v4-pro' }
  const { ctx } = createContext({
    llm: createLlm(),
    agentDefaultModel: { currentSelection: () => selection },
  })
  const catalog = await buildModelCatalog(ctx)
  assert.deepEqual(catalog.default, selection)
})

test('the model catalog degrades without an llm service', async () => {
  const { ctx } = createContext({ agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } })
  const catalog = await buildModelCatalog(ctx)
  assert.deepEqual(catalog.groups, [])
  assert.deepEqual(catalog.routableProviders, [])
  assert.deepEqual(catalog.default, { provider: 'p', model: 'm' })
})

test('only ordinary root sessions are eligible for preset routes', () => {
  assert.equal(isRootSession(undefined), false)
  assert.equal(isRootSession(null), false)
  assert.equal(isRootSession({ header: {} }), true)
  assert.equal(isRootSession({ header: { agentPreset: 'architect' } }), true)
  assert.equal(isRootSession({ header: { origin: 'subagent' } }), false)
  assert.equal(isRootSession({ header: { parentSession: 'session-0' } }), false)
})

test('the catalog route is registered through the web server', () => {
  const harness = createContext({ withInjection: true })
  mount(harness.ctx, CONFIG)

  assert.equal(harness.routes.length, 1)
  assert.equal(harness.routes[0].kind, 'exact')
  assert.equal(harness.routes[0].path, MODELS_PATH)
  assert.equal(typeof harness.routes[0].handler, 'function')
  assert.deepEqual(harness.settingsPolicies, [{ policy: { auto: false }, owner: harness.ctx.fiber }])
})

test('the plugin routes without a request listener', () => {
  const harness = createContext()
  mount(harness.ctx, CONFIG)

  // DSH 0.2.2 fixes the step model before prompt assembly and fails a request
  // whose listener proposes a different route, so the plugin must not listen.
  assert.deepEqual([...harness.listeners.keys()].sort(), ['agent-preset/selected', 'agent/created'])
})

test('a preset switch applies the configured route as the next model selection', async () => {
  const harness = createContext({ preset: 'architect', llm: createLlm() })
  mount(harness.ctx, CONFIG)

  await harness.emit('agent-preset/selected', 'session-1', 'architect')
  await flush()

  assert.deepEqual(harness.selections, [
    { provider: 'opencode-live', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
  ])
  assert.match(harness.infos.at(-1), /preset "architect" switches session "session-1" to opencode-live\/deepseek-v4-pro/)
})

test('a preset switch reads the live route map', async () => {
  let routes = { architect: { provider: 'opencode-live', model: 'deepseek-v4-pro' } }
  const harness = createContext({ preset: 'architect', llm: createLlm() })
  // The volatile field is a reference the settings service replaces in place,
  // exactly like the Configure page saving the map.
  mount(harness.ctx, { presets: { get: () => routes } })

  routes = { architect: { provider: 'opencode-live', model: 'deepseek-v4.1-flash' } }

  await harness.emit('agent-preset/selected', 'session-1', 'architect')
  await flush()

  assert.deepEqual(harness.selections, [
    { provider: 'opencode-live', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  ])
})

test('a superseded preset switch cannot overwrite the newer selection', async () => {
  const llm = createLlm({ deferred: true })
  const harness = createContext({ preset: 'architect', llm })
  mount(harness.ctx, TWO_ROUTES)

  await harness.emit('agent-preset/selected', 'session-1', 'architect')
  await harness.emit('agent-preset/selected', 'session-1', 'implementer')
  assert.equal(llm.pending.length, 2)

  // The older switch resolves last and must be dropped by its token.
  llm.pending[1].resolve({ ...llm.pending[1].config })
  llm.pending[0].resolve({ ...llm.pending[0].config })
  await flush()

  assert.deepEqual(harness.selections, [
    { provider: 'opencode-live', model: 'deepseek-v4.1-flash' },
  ])
})

test('a composer choice made while a switch resolves is not overwritten', async () => {
  const llm = createLlm({ deferred: true })
  const harness = createContext({ preset: 'architect', llm })
  mount(harness.ctx, CONFIG)

  await harness.emit('agent-preset/selected', 'session-1', 'architect')
  harness.chooseModel({ provider: 'deployment', model: 'user-choice' })
  llm.pending[0].resolve({ ...llm.pending[0].config })
  await flush()

  assert.deepEqual(harness.selections, [], 'the user choice wins')
})

test('a switch landing on another preset is dropped after resolution', async () => {
  const llm = createLlm({ deferred: true })
  const harness = createContext({ preset: 'architect', llm })
  mount(harness.ctx, CONFIG)

  // The second switch names a preset without a route: it supersedes the first
  // one without committing anything of its own.
  await harness.emit('agent-preset/selected', 'session-1', 'architect')
  await harness.emit('agent-preset/selected', 'session-1', 'reviewer')
  assert.equal(llm.pending.length, 1)

  llm.pending[0].resolve({ ...llm.pending[0].config })
  await flush()

  assert.deepEqual(harness.selections, [])
})

test('a preset without a route, a started session, and a subagent switch leave the model alone', async () => {
  const unconfigured = createContext({ preset: 'reviewer', llm: createLlm() })
  mount(unconfigured.ctx, CONFIG)
  await unconfigured.emit('agent-preset/selected', 'session-1', 'reviewer')
  await flush()
  assert.deepEqual(unconfigured.selections, [])

  const started = createContext({
    preset: 'architect',
    llm: createLlm(),
    requestHeader: { config: { provider: 'deployment', model: 'default' } },
  })
  mount(started.ctx, CONFIG)
  await started.emit('agent-preset/selected', 'session-1', 'architect')
  await flush()
  assert.deepEqual(started.selections, [], 'a started session keeps its logged route')

  const subagent = createContext({ preset: 'architect', llm: createLlm(), header: { origin: 'subagent' } })
  mount(subagent.ctx, CONFIG)
  await subagent.emit('agent-preset/selected', 'session-1', 'architect')
  await flush()
  assert.deepEqual(subagent.selections, [], 'a subagent session is never routed')
})

test('a preset switch without a live agent is ignored', async () => {
  const harness = createContext({ llm: createLlm() })
  mount(harness.ctx, CONFIG)

  await harness.emit('agent-preset/selected', 'session-unknown', 'architect')
  await flush()

  assert.deepEqual(harness.selections, [])
})

test('a preset switch without the Agent model selection API is inert', async () => {
  const harness = createContext({ llm: createLlm(), withModel: false })
  mount(harness.ctx, CONFIG)

  await harness.emit('agent-preset/selected', 'session-1', 'architect')
  await flush()

  assert.deepEqual(harness.selections, [])
})

test('a session created on a configured preset selects the route before its first prompt', async () => {
  const harness = createContext({ preset: 'architect', llm: createLlm() })
  mount(harness.ctx, CONFIG)

  await harness.emit('agent/created', { agent: harness.agent, source: 'startup' })
  await flush()

  assert.deepEqual(harness.selections, [
    { provider: 'opencode-live', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
  ])
})

test('a resumed, cleared, or compacted agent keeps the route recorded in its log', async () => {
  for (const source of ['resume', 'clear', 'compact']) {
    const harness = createContext({ preset: 'architect', llm: createLlm() })
    mount(harness.ctx, CONFIG)
    await harness.emit('agent/created', { agent: harness.agent, source })
    await flush()
    assert.deepEqual(harness.selections, [], `source "${source}" keeps the recorded route`)
  }
})

test('creation keeps a pending selection, an unconfigured preset, and a subagent untouched', async () => {
  const pending = createContext({
    preset: 'architect',
    llm: createLlm(),
    modelSelection: { pending: { provider: 'deployment', model: 'user-choice' } },
  })
  mount(pending.ctx, CONFIG)
  await pending.emit('agent/created', { agent: pending.agent, source: 'startup' })
  await flush()
  assert.deepEqual(pending.selections, [], 'a composer choice made before creation wins')

  const unconfigured = createContext({ preset: 'reviewer', llm: createLlm() })
  mount(unconfigured.ctx, CONFIG)
  await unconfigured.emit('agent/created', { agent: unconfigured.agent, source: 'startup' })
  await flush()
  assert.deepEqual(unconfigured.selections, [])

  const subagent = createContext({ preset: 'architect', llm: createLlm(), header: { origin: 'subagent' } })
  mount(subagent.ctx, CONFIG)
  await subagent.emit('agent/created', { agent: subagent.agent, source: 'startup' })
  await flush()
  assert.deepEqual(subagent.selections, [])
})

test('an unavailable route is reported and not applied', async () => {
  const llm = createLlm()
  llm.resolveCallConfig = async () => {
    throw new Error('model not served')
  }
  const harness = createContext({ preset: 'architect', llm })
  mount(harness.ctx, CONFIG)

  await harness.emit('agent/created', { agent: harness.agent, source: 'startup' })
  await flush()

  assert.deepEqual(harness.selections, [])
  assert.match(harness.warnings.at(-1), /preset "architect" route opencode-live\/deepseek-v4-pro is unavailable/)
})

test('a failing model selection is reported and swallowed', async () => {
  const harness = createContext({ preset: 'architect', llm: createLlm(), selectThrows: true })
  mount(harness.ctx, CONFIG)

  await harness.emit('agent/created', { agent: harness.agent, source: 'startup' })
  await flush()

  assert.deepEqual(harness.selections, [])
  assert.match(harness.warnings.at(-1), /preset "architect" could not be applied to session "session-1"/)
})

test('without a model service the configured route is committed unvalidated', async () => {
  const harness = createContext({ preset: 'architect' })
  mount(harness.ctx, CONFIG)

  await harness.emit('agent/created', { agent: harness.agent, source: 'startup' })
  await flush()

  assert.deepEqual(harness.selections, [{ provider: 'opencode-live', model: 'deepseek-v4-pro' }])
})

test('the Host plugin entry point exports the plugin contract and its schema', async () => {
  const module = await import('../index.js')
  assert.equal(typeof module.apply, 'function')
  assert.equal(module.name, 'dev-presets-model')
  assert.equal(typeof module.Config, 'function')
})
