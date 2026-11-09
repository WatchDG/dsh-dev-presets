/**
 * dsh-dev-presets — model routing on preset switch and on session creation,
 * the Configure-page data route, and the settings-page policy.
 *
 * A configured route reaches a Session through two listeners:
 *
 * - `agent-preset/selected` is the preset registry's own announcement that a
 *   Session committed a different preset to its durable log. It carries the
 *   Session id and the committed preset id, so the route is applied as the
 *   Session's next model selection right after the switch; the composer shows
 *   the preset model at once and the user can override it again through the
 *   normal model controls.
 * - `agent/created` applies the route when a fresh Session is created on a
 *   configured preset, before its first prompt is assembled.
 *
 * Both paths commit through `agent.model.select()`, the Agent's own durable
 * model selection: it appends the `model/selection` event that the model
 * selection projection folds, exactly like a composer choice, and it never
 * rewrites the deployment default model. `agent/request` is deliberately not
 * used: since DSH 0.2.2 the step model is fixed before prompt assembly and a
 * request listener that proposes a different route fails the request.
 *
 * The route map is read live: the Configure page writes volatile Config fields
 * and applies without a restart.
 */

import { buildModelCatalog } from './catalog.js'
import { snapshot } from './config.js'
import { normalizeRoutes, routeForPreset, sameSelection } from './routes.js'

/** Authenticated HTTP route the Configure page reads the model catalog from. */
export const MODELS_PATH = '/dev-presets/models'

/**
 * Read the preset id recorded for one live Session.
 *
 * The preset registry owns the `agentPreset` Session projection, so its
 * `presetForSession` read is authoritative (a blank Session can change its
 * preset). The header is the fallback for a context without the registry.
 *
 * @param {object} ctx Host context.
 * @param {object} agent Live Agent.
 * @returns {string | undefined} the preset id.
 */
function presetOf(ctx, agent) {
  const session = agent?.session
  const presets = ctx.get?.('agentPresets')
  if (typeof presets?.presetForSession === 'function' && session !== undefined) {
    const recorded = presets.presetForSession(session)
    if (typeof recorded === 'string' && recorded.length > 0) return recorded
  }

  const header = session?.header
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
 * Read the model selection a Session has pending but not yet used.
 *
 * The `modelSelection` projection exposes `{ lastUsed, next }`; a `next` that
 * differs from `lastUsed` is a committed selection no request has consumed yet,
 * which is how a composer choice looks before the Session starts.
 *
 * @param {object} ctx Host context.
 * @param {object} session Live Session.
 * @returns {object | undefined} the pending selection, if any.
 */
function pendingSelection(ctx, session) {
  const projections = ctx.get?.('sessionProjections')
  if (typeof projections?.snapshot !== 'function') return undefined

  const view = projections.snapshot(session, ['modelSelection'])?.values?.modelSelection
  if (view === null || typeof view !== 'object') return undefined

  const { lastUsed, next } = view
  if (next == null) return undefined
  return sameSelection(next, lastUsed) ? undefined : next
}

/**
 * Normalize one configured route against the live model catalogue.
 *
 * Resolving validates the route against the registered adapters, so a preset
 * that names a provider or model the deployment does not serve is reported
 * once and skipped instead of being committed.
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
 * `agent.model.select()` is the Agent's own durable selection commit: it
 * appends `model/selection`, the same event a composer choice appends, so the
 * `modelSelection` projection, the composer's model seat, and the next request
 * agree. The Remote `selectModel` is deliberately not used: it also persists
 * the route as the deployment default, and a preset switch must not rewrite the
 * default model of Sessions that run without a configured preset.
 *
 * @param {object} ctx Host context.
 * @param {object} agent Live Agent.
 * @param {string} preset Preset id that was selected.
 * @param {Record<string, object>} routes Normalized route map.
 * @param {object} [options] guards for the caller's timing.
 * @param {() => boolean} [options.isCurrent] guard against a superseded switch resolving late.
 * @param {boolean} [options.respectPending] keep a pending selection this plugin did not commit.
 * @returns {Promise<boolean>} whether the route was applied.
 */
async function applyPresetRoute(ctx, agent, preset, routes, options = {}) {
  const session = agent?.session
  if (!isRootSession(session) || hasRequestHeader(session)) return false

  const route = routeForPreset(routes, preset)
  if (route === undefined) return false

  const model = agent?.model
  if (typeof model?.select !== 'function') return false

  const pendingBefore = pendingSelection(ctx, session)

  const normalized = await resolveRoute(ctx, preset, route)
  if (normalized === undefined) return false
  if (options.isCurrent !== undefined && !options.isCurrent()) return false

  // Resolution is asynchronous: a preset switch or a composer choice may have
  // landed meanwhile. Only commit while this preset is still the session's and
  // no selection newer than the one observed at entry replaced it.
  if (hasRequestHeader(session)) return false

  const pendingNow = pendingSelection(ctx, session)
  if (pendingNow != null) {
    if (sameSelection(pendingNow, normalized)) return true
    if (options.respectPending === true) return false
    if (!sameSelection(pendingNow, pendingBefore)) return false
  }

  const sessionId = session.id ?? agent.id
  try {
    model.select(normalized)
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
   * @param {string} sessionId Session identity.
   * @returns {object | undefined} the Agent, or undefined without a live one.
   */
  const agentOf = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    return ctx.get?.('agents')?.get?.(sessionId)
  }

  // A preset switch applies the new preset's route as the Session's next model
  // selection, so the composer shows the preset model and a later composer or
  // `/model` choice overrides it normally. The announcement is emitted after
  // the `agent-preset/selected` append commits, so the selection is never
  // committed while that append is still being published.
  ctx.on('agent-preset/selected', (sessionId, preset) => {
    try {
      if (typeof preset !== 'string' || preset.length === 0) return
      const agent = agentOf(sessionId)
      if (agent === undefined) return
      const session = agent.session
      const token = (switchTokens.get(session) ?? 0) + 1
      switchTokens.set(session, token)
      applyPresetRoute(ctx, agent, preset, routesNow(), {
        isCurrent: () => switchTokens.get(session) === token,
      }).catch((error) => {
        ctx.logger?.warn?.(`dev-presets: preset "${preset}" model selection failed: ${String(error)}`)
      })
    } catch (error) {
      ctx.logger?.warn?.(`dev-presets: preset routing observer failed: ${String(error)}`)
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

      // A pending selection at creation means the user already chose a model
      // for this Session's first request, so the preset route must not replace it.
      if (pendingSelection(ctx, session) != null) return

      const preset = presetOf(ctx, agent)
      if (preset === undefined) return
      await applyPresetRoute(ctx, agent, preset, routesNow())
    } catch (error) {
      // A rejecting `agent/created` listener rolls the Agent creation back, so
      // a routing problem is logged here instead of failing the announcement.
      ctx.logger?.warn?.(`dev-presets: preset routing on creation failed: ${String(error)}`)
    }
  })
}
