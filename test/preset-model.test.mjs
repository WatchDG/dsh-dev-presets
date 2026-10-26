// Model-route plugin: config schema and live snapshot, catalog building,
// request eligibility, preset-switch and creation-time selection, and the Host
// request listener. No Harness is required: the tests use a fake context that
// records listeners and serves the optional services.
import test from 'node:test'
import assert from 'node:assert/strict'

import { Config, snapshot } from '../lib/config.js'
import { buildModelCatalog } from '../lib/catalog.js'
import { isFirstRootRequest, isRootSession, mount, MODELS_PATH } from '../lib/plugin.js'
import { normalizeRoutes, routeForPreset, sameSelection, withRoute } from '../lib/routes.js'

/**
 * Fake Host context: records listeners, resolves optional services by name,
 * collects the model selections the plugin installs, and collects route
 * registrations inside a fake child context.
 *
 * @param {{
 *   projections?: object,
 *   llm?: object,
 *   agentDefaultModel?: object,
 *   agents?: object[],
 *   withInjection?: boolean,
 *   withSelection?: boolean,
 *   selectThrows?: boolean,
 * }} [services]
 */
function createContext({
  projections,
  llm,
  agentDefaultModel,
  agents = [],
  withInjection = false,
  withSelection = true,
  selectThrows = false,
} = {}) {
  const listeners = new Map()
  const routes = []
  const warnings = []
  const infos = []
  const selections = []
  const controller = withSelection
    ? {
        agents: {
          selectForNextRequest: (agent, selection) => {
            if (selectThrows) throw new Error('the session writer is held')
            selections.push({ agent, selection })
          },
        },
      }
    : {}
  const ctx = {
    on: (name, listener) => {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    get: (name) => {
      if (name === 'sessionProjections') return projections
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return agentDefaultModel
      if (name === 'agents') return { get: (id) => agents.find((agent) => agent.id === id) }
      if (name === 'sessionController') return controller
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
  return { ctx, listeners, routes, warnings, infos, selections, controller }
}

/**
 * Fake live Agent whose Session exposes the header and request-header state the
 * listeners read, plus the projection states keyed by projection name.
 *
 * @param {{
 *   id?: string,
 *   preset?: string | null,
 *   header?: object,
 *   requestHeader?: object,
 *   modelSelection?: object,
 * }} [options]
 */
function createAgent({
  id = 'session-1',
  preset = 'architect',
  header = {},
  requestHeader,
  modelSelection,
} = {}) {
  const states = new Map([
    ['agentPreset', preset],
    ['modelSelection', modelSelection ?? { lastUsed: null, pending: null }],
  ])
  return {
    states,
    agent: {
      id,
      session: {
        id,
        header,
        requestHeader: () => requestHeader,
      },
    },
  }
}

/** Projection service over the Agent's own state map. */
function projectionsFor(agent) {
  return { stateOf: (session, key) => (session === agent.agent.session ? agent.states.get(key) : undefined) }
}

/** Fake LLM service over a fixed provider/model table. */
function createLlm({ failing = [] } = {}) {
  const providers = [
    { id: 'opencode-live', name: 'OpenCode' },
    { id: 'pi-ai', name: 'Pi AI' },
  ]
  return {
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
    resolveCallConfig: async (config) => ({ ...config, reasoningEffort: 'high' }),
  }
}

/** A plain Config value as the tests pass it (no volatile references). */
const CONFIG = { presets: { architect: { provider: 'opencode-live', model: 'deepseek-v4-pro' } } }
const BASE_CONFIG = { provider: 'deployment', model: 'default', temperature: 0.2, maxTokens: 4096, stop: ['END'] }

test('routes are normalized from the raw config map', () => {
  assert.deepEqual(normalizeRoutes(undefined), {})
  assert.deepEqual(normalizeRoutes(null), {})
  assert.deepEqual(normalizeRoutes('nonsense'), {})
  assert.deepEqual(
    normalizeRoutes({
      architect: { provider: 'opencode-live', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
      implementer: { provider: 'opencode-live', model: 'deepseek-v4.1-flash' },
      broken: { provider: '', model: 'm' },
      partial: { provider: 'p' },
      notAnObject: 'nope',
    }),
    {
      architect: { provider: 'opencode-live', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
      implementer: { provider: 'opencode-live', model: 'deepseek-v4.1-flash' },
    },
  )
})

test('a route is found only for an exact configured preset', () => {
  const routes = normalizeRoutes({ architect: { provider: 'p', model: 'm' } })
  assert.deepEqual(routeForPreset(routes, 'architect'), { provider: 'p', model: 'm' })
  assert.equal(routeForPreset(routes, 'reviewer'), undefined)
  assert.equal(routeForPreset(routes, undefined), undefined)
  assert.equal(routeForPreset(routes, ''), undefined)
})

test('selections are compared by provider, model, and effort', () => {
  assert.equal(sameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }), true)
  assert.equal(
    sameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm', reasoningEffort: 'high' }),
    false,
  )
  assert.equal(
    sameSelection(
      { provider: 'p', model: 'm', reasoningEffort: 'high' },
      { provider: 'p', model: 'm', reasoningEffort: 'high' },
    ),
    true,
  )
  assert.equal(sameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'n' }), false)
  assert.equal(sameSelection(null, undefined), false)
  assert.equal(sameSelection(undefined, undefined), true)
})

test('applying a route preserves sampling fields and drops the inherited effort', () => {
  assert.deepEqual(withRoute(BASE_CONFIG, { provider: 'x', model: 'y' }), {
    provider: 'x',
    model: 'y',
    temperature: 0.2,
    maxTokens: 4096,
    stop: ['END'],
  })
  assert.deepEqual(withRoute({ ...BASE_CONFIG, reasoningEffort: 'low' }, { provider: 'x', model: 'y', reasoningEffort: 'high' }), {
    provider: 'x',
    model: 'y',
    temperature: 0.2,
    maxTokens: 4096,
    stop: ['END'],
    reasoningEffort: 'high',
  })
})

test('the config schema accepts an empty map and volatile writes', () => {
  const parsed = Config({})
  assert.deepEqual({ ...parsed, presets: parsed.presets.get() }, { presets: {} })

  const configured = Config({
    presets: { architect: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
  })
  assert.deepEqual(configured.presets.get(), {
    architect: { provider: 'p', model: 'm', reasoningEffort: 'high' },
  })
})

test('the live snapshot unwraps volatile references and tolerates plain values', () => {
  assert.deepEqual(snapshot(undefined), { presets: {} })
  assert.deepEqual(snapshot({ presets: {} }), { presets: {} })
  assert.deepEqual(snapshot(CONFIG), CONFIG)
  assert.deepEqual(
    snapshot({ presets: { get: () => ({ reviewer: { provider: 'p', model: 'm' } }) } }),
    { presets: { reviewer: { provider: 'p', model: 'm' } } },
  )
  assert.deepEqual(snapshot({ presets: { get: () => { throw new Error('gone') } } }), { presets: {} })
})

test('the model catalog groups providers and isolates failures', async () => {
  const ctx = { get: (name) => (name === 'llm' ? createLlm({ failing: ['pi-ai'] }) : undefined) }
  const catalog = await buildModelCatalog(ctx)

  assert.deepEqual(catalog.routableProviders, ['opencode-live'])
  assert.equal(catalog.groups.length, 1)
  assert.equal(catalog.groups[0].id, 'opencode-live')
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
  assert.equal(catalog.default, null)
})

test('the model catalog reports the deployment default', async () => {
  const ctx = {
    get: (name) =>
      name === 'llm'
        ? createLlm()
        : name === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'opencode-live', model: 'deepseek-v4.1-flash' }) }
          : undefined,
  }
  const catalog = await buildModelCatalog(ctx)
  assert.deepEqual(catalog.default, { provider: 'opencode-live', model: 'deepseek-v4.1-flash' })
})

test('the model catalog degrades without an llm service', async () => {
  const catalog = await buildModelCatalog({ get: () => undefined })
  assert.deepEqual(catalog, {
    default: null,
    routableProviders: [],
    groups: [],
    failures: [],
  })
})

test('only the first request of an ordinary root Session is eligible', () => {
  const first = createAgent()
  const firstCtx = createContext({ projections: projectionsFor(first) }).ctx
  assert.equal(isFirstRootRequest(firstCtx, first.agent), true)

  const logged = createAgent({ requestHeader: { config: { provider: 'p', model: 'm' } } })
  const loggedCtx = createContext({ projections: projectionsFor(logged) }).ctx
  assert.equal(isFirstRootRequest(loggedCtx, logged.agent), false)

  const pending = createAgent({ modelSelection: { lastUsed: null, pending: { provider: 'p', model: 'm' } } })
  const pendingCtx = createContext({ projections: projectionsFor(pending) }).ctx
  assert.equal(isFirstRootRequest(pendingCtx, pending.agent), false)

  const child = createAgent({ header: { parentSession: 'session-parent' } })
  const childCtx = createContext({ projections: projectionsFor(child) }).ctx
  assert.equal(isFirstRootRequest(childCtx, child.agent), false)

  const subagent = createAgent({ header: { origin: 'subagent' } })
  const subagentCtx = createContext({ projections: projectionsFor(subagent) }).ctx
  assert.equal(isFirstRootRequest(subagentCtx, subagent.agent), false)

  const missing = createContext().ctx
  assert.equal(isFirstRootRequest(missing, { session: {} }), true)
})

test('an empty route map registers no catalog route without injection support and reads live config', async () => {
  const { ctx, routes, listeners } = createContext()
  mount(ctx, {})
  assert.equal(routes.length, 0)
  assert.deepEqual([...listeners.keys()].sort(), ['agent/created', 'agent/request', 'session/event'])
})

test('the catalog route is registered through the web server', () => {
  const agent = createAgent()
  const { ctx, routes } = createContext({
    projections: projectionsFor(agent),
    llm: createLlm(),
    withInjection: true,
  })
  mount(ctx, CONFIG)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, MODELS_PATH)
})

test('the first request is routed to the configured preset model', async () => {
  const agent = createAgent()
  const { ctx, listeners, infos } = createContext({ projections: projectionsFor(agent), llm: createLlm() })
  mount(ctx, CONFIG)

  const result = await listeners.get('agent/request')({ agent: agent.agent }, async () => BASE_CONFIG)

  assert.equal(result.provider, 'opencode-live')
  assert.equal(result.model, 'deepseek-v4-pro')
  assert.equal(result.reasoningEffort, 'high')
  assert.equal(result.temperature, 0.2)
  assert.equal(result.maxTokens, 4096)
  assert.equal(infos.length, 1)
  assert.match(infos[0], /preset "architect" starts on opencode-live\/deepseek-v4-pro/)
})

test('a live config write applies without a restart', async () => {
  const agent = createAgent()
  const { ctx, listeners } = createContext({ projections: projectionsFor(agent) })
  let live = {}
  mount(ctx, { presets: { get: () => live } })

  assert.deepEqual(
    await listeners.get('agent/request')({ agent: agent.agent }, async () => BASE_CONFIG),
    BASE_CONFIG,
  )

  live = { architect: { provider: 'opencode-live', model: 'deepseek-v4-pro' } }
  const routed = await listeners.get('agent/request')({ agent: agent.agent }, async () => BASE_CONFIG)
  assert.equal(routed.provider, 'opencode-live')
  assert.equal(routed.model, 'deepseek-v4-pro')
})

test('a later request, an explicit selection, and a subagent keep the resolved route', async () => {
  for (const agent of [
    createAgent({ requestHeader: { config: { provider: 'deployment', model: 'default' } } }),
    createAgent({ modelSelection: { lastUsed: null, pending: { provider: 'chosen', model: 'model' } } }),
    createAgent({ header: { parentSession: 'session-parent' } }),
  ]) {
    const { ctx, listeners, infos } = createContext({ projections: projectionsFor(agent) })
    mount(ctx, CONFIG)

    const result = await listeners.get('agent/request')({ agent: agent.agent }, async () => BASE_CONFIG)
    assert.deepEqual(result, BASE_CONFIG)
    assert.equal(infos.length, 0)
  }
})

test('an unknown preset or an unavailable route falls back to the resolved config', async () => {
  const unknown = createAgent({ preset: 'other' })
  const unknownHarness = createContext({ projections: projectionsFor(unknown) })
  mount(unknownHarness.ctx, CONFIG)
  assert.deepEqual(
    await unknownHarness.listeners.get('agent/request')({ agent: unknown.agent }, async () => BASE_CONFIG),
    BASE_CONFIG,
  )

  const unavailable = createAgent()
  const failingLlm = {
    ...createLlm(),
    resolveCallConfig: async () => {
      throw new Error('no adapter for provider')
    },
  }
  const unavailableHarness = createContext({ projections: projectionsFor(unavailable), llm: failingLlm })
  mount(unavailableHarness.ctx, CONFIG)
  assert.deepEqual(
    await unavailableHarness.listeners.get('agent/request')({ agent: unavailable.agent }, async () => BASE_CONFIG),
    BASE_CONFIG,
  )
  assert.equal(unavailableHarness.warnings.length, 1)
  assert.match(unavailableHarness.warnings[0], /route opencode-live\/deepseek-v4-pro is unavailable/)
})

test('without a model service the configured route is applied unvalidated', async () => {
  const agent = createAgent()
  const { ctx, listeners } = createContext({ projections: projectionsFor(agent) })
  mount(ctx, { presets: { architect: { provider: 'p', model: 'm', reasoningEffort: 'low' } } })

  const result = await listeners.get('agent/request')({ agent: agent.agent }, async () => BASE_CONFIG)
  assert.equal(result.provider, 'p')
  assert.equal(result.model, 'm')
  assert.equal(result.reasoningEffort, 'low')
})

test('only ordinary root sessions are eligible for preset routes', () => {
  assert.equal(isRootSession({ header: {} }), true)
  assert.equal(isRootSession(undefined), false)
  assert.equal(isRootSession(null), false)
  assert.equal(isRootSession({ header: { origin: 'subagent' } }), false)
  assert.equal(isRootSession({ header: { parentSession: 'session-parent' } }), false)
})

const SELECTED_ARCHITECT = {
  provider: 'opencode-live',
  model: 'deepseek-v4-pro',
  reasoningEffort: 'high',
}

test('a preset switch applies the configured route as the next model selection', async () => {
  const agent = createAgent()
  const { ctx, listeners, infos, selections } = createContext({
    projections: projectionsFor(agent),
    llm: createLlm(),
    agents: [agent.agent],
  })
  mount(ctx, CONFIG)

  const applied = await listeners.get('session/event')(agent.agent.session, {
    type: 'agent-preset/selected',
    data: { agentPreset: 'architect' },
  })

  assert.equal(applied, true)
  assert.equal(selections.length, 1)
  assert.equal(selections[0].agent, agent.agent)
  assert.deepEqual(selections[0].selection, SELECTED_ARCHITECT)
  assert.match(
    infos[0],
    /preset "architect" switches session "session-1" to opencode-live\/deepseek-v4-pro/,
  )
})

test('a preset switch reads the live route map', async () => {
  const agent = createAgent()
  const { ctx, listeners, selections } = createContext({
    projections: projectionsFor(agent),
    agents: [agent.agent],
  })
  let live = {}
  mount(ctx, { presets: { get: () => live } })
  const event = { type: 'agent-preset/selected', data: { agentPreset: 'architect' } }

  assert.equal(await listeners.get('session/event')(agent.agent.session, event), false)
  assert.equal(selections.length, 0)

  live = { architect: { provider: 'p', model: 'm' } }
  assert.equal(await listeners.get('session/event')(agent.agent.session, event), true)
  assert.deepEqual(selections[0].selection, { provider: 'p', model: 'm' })
})

test('a superseded preset switch cannot overwrite the newer selection', async () => {
  const agent = createAgent()
  const gates = []
  const deferredLlm = {
    ...createLlm(),
    resolveCallConfig: (config) =>
      new Promise((resolve) => {
        gates.push(() => resolve({ ...config, reasoningEffort: 'high' }))
      }),
  }
  const { ctx, listeners, selections } = createContext({
    projections: projectionsFor(agent),
    llm: deferredLlm,
    agents: [agent.agent],
  })
  mount(ctx, {
    presets: {
      architect: { provider: 'opencode-live', model: 'deepseek-v4-pro' },
      implementer: { provider: 'opencode-live', model: 'deepseek-v4.1-flash' },
    },
  })

  const older = listeners.get('session/event')(agent.agent.session, {
    type: 'agent-preset/selected',
    data: { agentPreset: 'architect' },
  })
  agent.states.set('agentPreset', 'implementer')
  const newer = listeners.get('session/event')(agent.agent.session, {
    type: 'agent-preset/selected',
    data: { agentPreset: 'implementer' },
  })

  gates[1]()
  assert.equal(await newer, true)
  gates[0]()
  assert.equal(await older, false)

  assert.equal(selections.length, 1)
  assert.equal(selections[0].selection.model, 'deepseek-v4.1-flash')
})

test('a composer choice made while a switch resolves is not overwritten', async () => {
  const agent = createAgent()
  const gates = []
  const deferredLlm = {
    ...createLlm(),
    resolveCallConfig: (config) =>
      new Promise((resolve) => {
        gates.push(() => resolve({ ...config, reasoningEffort: 'high' }))
      }),
  }
  const { ctx, listeners, selections } = createContext({
    projections: projectionsFor(agent),
    llm: deferredLlm,
    agents: [agent.agent],
  })
  mount(ctx, CONFIG)

  const pending = listeners.get('session/event')(agent.agent.session, {
    type: 'agent-preset/selected',
    data: { agentPreset: 'architect' },
  })
  agent.states.set('modelSelection', {
    lastUsed: null,
    pending: { provider: 'chosen', model: 'model' },
  })
  gates[0]()

  assert.equal(await pending, false)
  assert.equal(selections.length, 0)
})

test('a switch landing on another preset is dropped after resolution', async () => {
  const agent = createAgent()
  const gates = []
  const deferredLlm = {
    ...createLlm(),
    resolveCallConfig: (config) =>
      new Promise((resolve) => {
        gates.push(() => resolve({ ...config, reasoningEffort: 'high' }))
      }),
  }
  const { ctx, listeners, selections } = createContext({
    projections: projectionsFor(agent),
    llm: deferredLlm,
    agents: [agent.agent],
  })
  mount(ctx, { presets: { architect: { provider: 'opencode-live', model: 'deepseek-v4-pro' } } })

  const stale = listeners.get('session/event')(agent.agent.session, {
    type: 'agent-preset/selected',
    data: { agentPreset: 'architect' },
  })
  agent.states.set('agentPreset', 'reviewer')
  gates[0]()

  assert.equal(await stale, false)
  assert.equal(selections.length, 0)
})

test('a preset without a route, a started session, and a subagent switch leave the model alone', async () => {
  const unconfigured = createAgent({ preset: 'reviewer' })
  const unconfiguredHarness = createContext({
    projections: projectionsFor(unconfigured),
    llm: createLlm(),
    agents: [unconfigured.agent],
  })
  mount(unconfiguredHarness.ctx, CONFIG)
  assert.equal(
    await unconfiguredHarness.listeners.get('session/event')(unconfigured.agent.session, {
      type: 'agent-preset/selected',
      data: { agentPreset: 'reviewer' },
    }),
    false,
  )
  assert.equal(unconfiguredHarness.selections.length, 0)

  for (const agent of [
    createAgent({ requestHeader: { config: { provider: 'deployment', model: 'default' } } }),
    createAgent({ header: { parentSession: 'session-parent' } }),
    createAgent({ header: { origin: 'subagent' } }),
  ]) {
    const harness = createContext({
      projections: projectionsFor(agent),
      llm: createLlm(),
      agents: [agent.agent],
    })
    mount(harness.ctx, CONFIG)
    assert.equal(
      await harness.listeners.get('session/event')(agent.agent.session, {
        type: 'agent-preset/selected',
        data: { agentPreset: 'architect' },
      }),
      false,
    )
    assert.equal(harness.selections.length, 0)
  }
})

test('a preset switch without a live agent or a manual model selection is ignored', async () => {
  const idle = createAgent()
  const idleHarness = createContext({ projections: projectionsFor(idle), llm: createLlm(), agents: [] })
  mount(idleHarness.ctx, CONFIG)
  assert.equal(
    await idleHarness.listeners.get('session/event')(idle.agent.session, {
      type: 'agent-preset/selected',
      data: { agentPreset: 'architect' },
    }),
    undefined,
  )
  assert.equal(idleHarness.selections.length, 0)

  const switched = createAgent()
  const switchedHarness = createContext({
    projections: projectionsFor(switched),
    llm: createLlm(),
    agents: [switched.agent],
  })
  mount(switchedHarness.ctx, CONFIG)
  assert.equal(
    await switchedHarness.listeners.get('session/event')(switched.agent.session, {
      type: 'model/selection',
      data: { provider: 'chosen', model: 'model' },
    }),
    undefined,
  )
  assert.equal(switchedHarness.selections.length, 0)
})

test('a session created on a configured preset selects the route before its first prompt', async () => {
  const agent = createAgent()
  const { ctx, listeners, selections } = createContext({
    projections: projectionsFor(agent),
    llm: createLlm(),
    agents: [agent.agent],
  })
  mount(ctx, CONFIG)

  await listeners.get('agent/created')({ agent: agent.agent, source: 'startup' })

  assert.equal(selections.length, 1)
  assert.deepEqual(selections[0].selection, SELECTED_ARCHITECT)
})

test('a resumed, cleared, or compacted agent keeps the route recorded in its log', async () => {
  for (const source of ['resume', 'clear', 'compaction']) {
    const agent = createAgent()
    const { ctx, listeners, selections } = createContext({
      projections: projectionsFor(agent),
      llm: createLlm(),
      agents: [agent.agent],
    })
    mount(ctx, CONFIG)

    await listeners.get('agent/created')({ agent: agent.agent, source })
    assert.equal(selections.length, 0, `${source} creation must not reselect the preset route`)
  }
})

test('creation keeps a pending selection, an unconfigured preset, and a subagent untouched', async () => {
  const pending = createAgent({
    modelSelection: { lastUsed: null, pending: { provider: 'chosen', model: 'model' } },
  })
  const pendingHarness = createContext({
    projections: projectionsFor(pending),
    llm: createLlm(),
    agents: [pending.agent],
  })
  mount(pendingHarness.ctx, CONFIG)
  await pendingHarness.listeners.get('agent/created')({ agent: pending.agent, source: 'startup' })
  assert.equal(pendingHarness.selections.length, 0)

  const unconfigured = createAgent({ preset: 'reviewer' })
  const unconfiguredHarness = createContext({
    projections: projectionsFor(unconfigured),
    llm: createLlm(),
    agents: [unconfigured.agent],
  })
  mount(unconfiguredHarness.ctx, CONFIG)
  await unconfiguredHarness.listeners.get('agent/created')({
    agent: unconfigured.agent,
    source: 'startup',
  })
  assert.equal(unconfiguredHarness.selections.length, 0)

  const child = createAgent({ header: { origin: 'subagent' } })
  const childHarness = createContext({
    projections: projectionsFor(child),
    llm: createLlm(),
    agents: [child.agent],
  })
  mount(childHarness.ctx, CONFIG)
  await childHarness.listeners.get('agent/created')({ agent: child.agent, source: 'startup' })
  assert.equal(childHarness.selections.length, 0)
})

test('an unavailable route and a held session writer are reported and not applied', async () => {
  const failingLlm = {
    ...createLlm(),
    resolveCallConfig: async () => {
      throw new Error('no adapter for provider')
    },
  }
  const unavailable = createAgent()
  const unavailableHarness = createContext({
    projections: projectionsFor(unavailable),
    llm: failingLlm,
    agents: [unavailable.agent],
  })
  mount(unavailableHarness.ctx, CONFIG)
  await unavailableHarness.listeners.get('agent/created')({
    agent: unavailable.agent,
    source: 'startup',
  })
  assert.equal(unavailableHarness.selections.length, 0)
  assert.match(unavailableHarness.warnings[0], /route opencode-live\/deepseek-v4-pro is unavailable/)

  const held = createAgent()
  const heldHarness = createContext({
    projections: projectionsFor(held),
    llm: createLlm(),
    agents: [held.agent],
    selectThrows: true,
  })
  mount(heldHarness.ctx, CONFIG)
  await heldHarness.listeners.get('agent/created')({ agent: held.agent, source: 'startup' })
  assert.equal(heldHarness.selections.length, 0)
  assert.match(heldHarness.warnings[0], /could not be applied to session "session-1"/)
})

test('without the session selection API the creation hook is inert and the first request is routed', async () => {
  const agent = createAgent()
  const { ctx, listeners, selections } = createContext({
    projections: projectionsFor(agent),
    llm: createLlm(),
    agents: [agent.agent],
    withSelection: false,
  })
  mount(ctx, CONFIG)

  await listeners.get('agent/created')({ agent: agent.agent, source: 'startup' })
  assert.equal(selections.length, 0)

  const result = await listeners.get('agent/request')({ agent: agent.agent }, async () => BASE_CONFIG)
  assert.equal(result.provider, 'opencode-live')
  assert.equal(result.model, 'deepseek-v4-pro')
})

test('the Host plugin entry point exports the plugin contract and its schema', async () => {
  const module = await import('../index.js')
  assert.equal(typeof module.apply, 'function')
  assert.equal(module.name, 'dev-presets-model')
  assert.equal(typeof module.Config, 'function')
})
