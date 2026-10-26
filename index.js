/**
 * dsh-dev-presets — optional default model routes per preset.
 *
 * The bundle's presets are YAML compositions; the model a session starts with
 * is not part of a preset declaration in DSH. This Host plugin narrows that gap
 * for deployments that want it:
 *
 * - switching a blank Session to a configured preset applies the preset's
 *   provider/model as the Session's next model selection, so the composer shows
 *   it at once and a later composer or `/model` choice overrides it normally;
 * - a fresh Session created on a configured preset starts on that route;
 * - the first model request of a Session composed with a configured preset is
 *   still routed as a fallback, so a deployment without a live Session
 *   controller or an already-created Agent keeps the old behavior.
 *
 * It is not a per-request override: once the first request is logged as the
 * Session's request header, the usual rules apply again — an explicit model
 * choice through the composer or `/model` wins, and resumed Sessions keep the
 * route recorded in their log. Subagent Sessions are never touched. The
 * deployment default model is never rewritten by the preset switch.
 *
 * Config: the `presets` map of preset id to provider/model route. It is
 * volatile, so the Settings page (Settings → Development Presets) edits it
 * live; the shipped default is empty and keeps the plugin inert. The same map
 * can be written in the profile patch layer:
 *
 *   presets:
 *     architect:
 *       provider: opencode-live
 *       model: deepseek-v4-pro
 *       reasoningEffort: high    optional
 */

import { Config } from './lib/config.js'
import { mount } from './lib/plugin.js'

/**
 * Activate the plugin for one profile.
 *
 * @param {object} ctx Plugin context supplied by the DSH loader.
 * @param {unknown} config Bundle row config.
 */
export function apply(ctx, config) {
  mount(ctx, config)
}

export { Config }
export const name = 'dev-presets-model'
