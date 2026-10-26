/**
 * dsh-dev-presets — model routing on preset switch and on the first request,
 * the Configure-page data route, and the settings-page policy.
 *
 * A configured route reaches a Session through three listeners:
 *
 * - `session/event` sees an `agent-preset/selected` append and applies the new
 *   preset's route as the Session's next model selection, so the composer shows
 *   the preset model right after the switch and the user can override it again
 *   through the normal model controls.
 * - `agent/created` applies the route when a fresh Session is created on a
 *   configured preset, before its first prompt is assembled.
 * - `agent/request` remains the fallback for a Session the controller could not
 *   be addressed through: it runs outermost in the waterfall, so it can supply
 *   the route the controller will then log as the Session's first request
 *   header.
 *
 * The route map is read live: the Configure page writes volatile Config fields
 * and applies without a restart.
 */

import { buildModelCatalog } from './catalog.js'
import { snapshot } from './config.js'
import { normalizeRoutes, routeForPreset, sameSelection, withRoute } from './routes.js'

/** Authenticated HTTP route the Configure page reads the model catalog from. */
export const MODELS_PATH = '/dev-presets/models'

/**
 * Read the preset id recorded for one live Session.
 *
 * The durable projection is authoritative (a blank Session can change its
 * preset); the header is the fallback for a context without projections.
 *
 * @param {object} ctx Host context.
 * @param {object} agent Live Agent.
 * @returns {string | undefined} the preset id.
 */
function presetOf(ctx, agent) {
  const projections = ctx.get?.('sessionProjections')
  const projected = projections?.stateOf?.(agent.session, 'agentPreset')
  if (typeof projected === 'string' && projected.length > 0) return projected

  const header = agent.session?.header
  return typeof header?.agentPreset === 'string' && header.agentPreset.length > 0
    ? header.agentPreset
    : undefined
}

/**
 * Report whether a Session is an ordinary root Session.
 *
 * A preset route is a starting point for the user's own conversation: subagent
 * and forked descendant Sessions inherit their own routing and are never
 * touched here.
 *
 * @param {object | undefined} session Live Session.
 * @returns {boolean} whether the Session may receive a preset route.
 */
export function isRootSession(session) {
  if (session === undefined || session === null) return false
  const header = session.header
  if (header?.origin === 'subagent' || header?.parentSession !== undefined) return false
  return true
}

/**
 * Report whether a Session has already logged a model request.
 *
 * A Session that started keeps the route recorded in its log; only a blank
 * Session's model may be changed by a preset.
 *
 * @param {object} session Live Session.
 * @returns {boolean} whether a request header exists.
 */
function hasRequestHeader(session) {
  return typeof session.requestHeader === 'function' && session.requestHeader() !== undefined
}

/**
 * Report whether a request is the first model call of an ordinary root Session.
 *
 * Later requests already carry a logged route and must stay under the normal
 * model-selection rules. A pending selection means the user already chose a
 * model for the next request, so the preset route must not override it.
 *
 * @param {object} ctx Host context.
 * @param {object} agent Live Agent.
 * @returns {boolean} whether the preset route may be applied.
 */
export function isFirstRootRequest(ctx, agent) {
  const session = agent.session
  if (session === undefined || session === null) return false
  if (!isRootSession(session)) return false
  if (hasRequestHeader(session)) return false

  const projections = ctx.get?.('sessionProjections')
  const modelSelection = projections?.stateOf?.(session, 'modelSelection')
  return modelSelection?.pending == null
}

/**
 * Normalize one configured route against the live model catalogue.
 *
 * @param {object} ctx Host context.
 * @param {string} preset Preset id, for diagnostics.
 * @param {object} route Configured route.
 * @returns {Promise<object | undefined>} the resolved route, or undefined when unavailable.
 */
async function resolveRoute(ctx, preset, route) {
  const llm = ctx.get?.('llm')
  if (typeof llm?.resolveCallConfig !== 'function') return route

  try {
    const resolved = await llm.resolveCallConfig({ ...route })
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
  } catch (error) {
    ctx.logger?.warn?.(
      `dev-presets: preset "${preset}" route ${route.provider}/${route.model} is unavailable; the current model is kept: ${String(error)}`,
    )
    return undefined
  }
}

/**
 * Apply one preset's configured route to a live blank Session as its next
 * model selection.
 *
 * The Session controller owns model selection: `selectForNextRequest` is the
 * same commit a composer choice performs, so the `modelSelection` projection,
 * the composer's model seat, and the next request agree. The Remote
 * `selectModel` is deliberately not used: it also persists the route as the
 * deployment default, and a preset switch must not rewrite the default model
 * of Sessions that run without a configured preset.
 *
 * @param {object} ctx Host context.
 * @param {object} agent Live Agent.
 * @param {string} preset Preset id that was selected.
 * @param {Record<string, object>} routes Normalized route map.
 * @param {() => boolean} [isCurrent] guard against a superseded switch resolving late.
 * @returns {Promise<boolean>} whether the route was applied.
 */
async function applyPresetRoute(ctx, agent, preset, routes, isCurrent) {
  const session = agent?.session
  if (!isRootSession(session) || hasRequestHeader(session)) return false

  const route = routeForPreset(routes, preset)
  if (route === undefined) return false

  const selections = ctx.get?.('sessionController')?.agents
  if (typeof selections?.selectForNextRequest !== 'function') return false

  const projections = ctx.get?.('sessionProjections')
  const pendingBefore = projections?.stateOf?.(session, 'modelSelection')?.pending

  const normalized = await resolveRoute(ctx, preset, route)
  if (normalized === undefined) return false
  if (isCurrent !== undefined && !isCurrent()) return false

  // Resolution is asynchronous: a preset switch or a composer choice may have
  // landed meanwhile. Only commit while this preset is still the session's and
  // no selection newer than the one observed at entry replaced it.
  if (hasRequestHeader(session)) return false
  if (typeof projections?.stateOf === 'function') {
    const projectedPreset = projections.stateOf(session, 'agentPreset')
    if (typeof projectedPreset === 'string' && projectedPreset !== preset) return false

    const pendingNow = projections.stateOf(session, 'modelSelection')?.pending
    if (pendingNow != null && sameSelection(pendingNow, normalized)) return true
    if (pendingNow != null && !sameSelection(pendingNow, pendingBefore)) return false
  }

  const sessionId = session.id ?? agent.id
  try {
    selections.selectForNextRequest(agent, normalized)
  } catch (error) {
    ctx.logger?.warn?.(
      `dev-presets: preset "${preset}" could not be applied to session "${String(sessionId)}": ${String(error)}`,
    )
    return false
  }

  ctx.logger?.info?.(
    `dev-presets: preset "${preset}" switches session "${String(sessionId)}" to ${normalized.provider}/${normalized.model}`,
  )
  return true
}

/**
 * Shared gate for the Configure routes: browser-trust rejection, then method.
 *
 * @returns {boolean} true when the request was answered here.
 */
function gate(child, req, res, methods) {
  const rejection = child.connection.requestRejection(req)
  if (rejection !== undefined) {
    res.statusCode = rejection
    res.end()
    return true
  }
  if (!methods.includes(req.method)) {
    res.statusCode = 405
    res.setHeader('allow', methods.join(', '))
    res.end()
    return true
  }
  return false
}

/** Send a JSON payload with no-store caching. */
function json(res, code, body) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Serve the model catalog the Configure page lists models from.
 *
 * @param {object} ctx Host context.
 */
function registerCatalogRoute(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer', 'connection'], (child) => {
    child.effect(
      () =>
        child.webServer.register({
          kind: 'exact',
          path: MODELS_PATH,
          handler: async (req, res) => {
            if (gate(child, req, res, ['GET'])) return
            try {
              json(res, 200, await buildModelCatalog(child))
            } catch (error) {
              json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          },
        }),
      `dev-presets: GET ${MODELS_PATH}`,
    )
  })
}

/**
 * Mark the plugin's configuration as page-owned: this bundle ships its own
 * Configure page, so the settings service must not generate one.
 *
 * @param {object} ctx Host context.
 */
function registerSettingsPolicy(ctx) {
  if (typeof ctx.inject !== 'function' || ctx.fiber === undefined) return
  ctx.inject(['settings'], (child) => {
    child.effect(
      () => child.settings.configure({ auto: false }, ctx.fiber),
      'dev-presets: own configure page',
    )
  })
}

/**
 * Wire the preset routes and the Configure-page data into one Host context.
 *
 * @param {object} ctx Host context.
 * @param {unknown} rawConfig Bundle row config, possibly with volatile references.
 */
export function mount(ctx, rawConfig) {
  registerCatalogRoute(ctx)
  registerSettingsPolicy(ctx)

  const routesNow = () => normalizeRoutes(snapshot(rawConfig).presets)

  /**
   * Newest preset-switch request per Session. Model resolution is asynchronous,
   * so a slower older switch must not overwrite the preset the user selected
   * last.
   */
  const switchTokens = new WeakMap()

  /**
   * Resolve the live Agent of one Session identity, when it is registered.
   *
   * @param {object} session Live Session.
   * @returns {object | undefined} the Agent, or undefined without a live one.
   */
  const agentOf = (session) => {
    const id = session?.id
    if (typeof id !== 'string' || id.length === 0) return undefined
    return ctx.get?.('agents')?.get?.(id)
  }

  // A preset switch applies the new preset's route as the Session's next model
  // selection, so the composer shows the preset model and a later composer or
  // `/model` choice overrides it normally. The append is deferred: committing
  // `model/selection` while `agent-preset/selected` is still being published
  // would re-enter the Session append path.
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'agent-preset/selected') return undefined
      const preset = event.data?.agentPreset
      if (typeof preset !== 'string' || preset.length === 0) return undefined
      const agent = agentOf(session)
      if (agent === undefined) return undefined
      const token = (switchTokens.get(session) ?? 0) + 1
      switchTokens.set(session, token)
      return applyPresetRoute(ctx, agent, preset, routesNow(), () => switchTokens.get(session) === token).catch(
        (error) => {
          ctx.logger?.warn?.(
            `dev-presets: preset "${preset}" model selection failed: ${String(error)}`,
          )
          return false
        },
      )
    } catch (error) {
      ctx.logger?.warn?.(`dev-presets: preset routing observer failed: ${String(error)}`)
      return undefined
    }
  })

  // A fresh Session created on a configured preset starts on that route: the
  // creation announcement is awaited, so the selection is committed before the
  // first prompt is assembled. A resumed, cleared, or compacted Agent keeps the
  // route already recorded in its log.
  ctx.on('agent/created', async (payload) => {
    try {
      const { agent, source } = payload ?? {}
      if (source !== 'startup') return
      const session = agent?.session
      if (!isRootSession(session) || hasRequestHeader(session)) return

      const projections = ctx.get?.('sessionProjections')
      if (projections?.stateOf?.(session, 'modelSelection')?.pending != null) return

      const preset = presetOf(ctx, agent)
      if (preset === undefined) return
      await applyPresetRoute(ctx, agent, preset, routesNow())
    } catch (error) {
      // A rejecting `agent/created` listener rolls the Agent creation back, so
      // a routing problem is logged here instead of failing the announcement.
      ctx.logger?.warn?.(`dev-presets: preset routing on creation failed: ${String(error)}`)
    }
  })

  ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    if (!isFirstRootRequest(ctx, agent)) return resolved

    const routes = routesNow()
    const preset = presetOf(ctx, agent)
    const route = routeForPreset(routes, preset)
    if (route === undefined) return resolved

    const normalized = await resolveRoute(ctx, preset, route)
    if (normalized === undefined) return resolved

    ctx.logger?.info?.(
      `dev-presets: preset "${preset}" starts on ${normalized.provider}/${normalized.model}`,
    )
    return withRoute(resolved, normalized)
  })
}
