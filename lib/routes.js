/**
 * Default model routes per preset — validation of the plugin's config.
 *
 * The bundle row's `config` is user-authored YAML, so the map is validated
 * once at activation and reduced to the plain shape the request listener
 * consumes. An entry is ignored (not half-applied) unless it names both a
 * provider and a model.
 */

/**
 * @typedef {object} ModelRoute
 * @property {string} provider Registered provider route.
 * @property {string} model Provider-owned model id.
 * @property {string} [reasoningEffort] Adapter-owned effort id.
 */

/**
 * Normalize the `presets` field of the plugin config.
 *
 * @param {unknown} value Raw config value.
 * @returns {Record<string, ModelRoute>} Routes keyed by preset id.
 */
export function normalizeRoutes(value) {
  /** @type {Record<string, ModelRoute>} */
  const routes = {}
  if (typeof value !== 'object' || value === null) return routes

  for (const [preset, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { provider, model, reasoningEffort } = entry
    if (typeof provider !== 'string' || provider.length === 0) continue
    if (typeof model !== 'string' || model.length === 0) continue
    routes[preset] = {
      provider,
      model,
      ...(typeof reasoningEffort === 'string' && reasoningEffort.length > 0
        ? { reasoningEffort }
        : {}),
    }
  }

  return routes
}

/**
 * Find the route configured for one preset id.
 *
 * @param {Record<string, ModelRoute>} routes Normalized routes.
 * @param {string | undefined} preset Preset id recorded for the Session.
 * @returns {ModelRoute | undefined} the configured route, if any.
 */
export function routeForPreset(routes, preset) {
  if (typeof preset !== 'string' || preset.length === 0) return undefined
  return Object.hasOwn(routes, preset) ? routes[preset] : undefined
}

/**
 * Compare two complete model selections.
 *
 * The pair is provider and model; reasoning effort is part of the identity, and
 * an absent effort is distinct from any named one.
 *
 * @param {{ provider: string, model: string, reasoningEffort?: string } | null | undefined} left
 * @param {{ provider: string, model: string, reasoningEffort?: string } | null | undefined} right
 * @returns {boolean} whether both name the same selection.
 */
export function sameSelection(left, right) {
  if (left === right) return true
  if (left == null || right == null) return false
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    (left.reasoningEffort ?? null) === (right.reasoningEffort ?? null)
  )
}

/**
 * Replace the route fields of one resolved call configuration.
 *
 * An inherited effort belongs to the route it was resolved for, so it is
 * dropped unless the configured route names its own effort. Every other field
 * of the resolved configuration (temperature, max tokens, stop) is preserved.
 *
 * @param {Record<string, unknown>} config Resolved call configuration.
 * @param {ModelRoute} route Route to apply.
 * @returns {Record<string, unknown>} the configuration with the route replaced.
 */
export function withRoute(config, route) {
  const { reasoningEffort: _inherited, ...rest } = config
  return {
    ...rest,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
}
