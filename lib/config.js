/**
 * dsh-dev-presets — configuration: the volatile route map.
 *
 * The `presets` map is volatile because the Configure page edits it live: the
 * settings service exposes volatile fields and a write replaces the reference
 * in place, so the request listener reads the current map on every request
 * instead of snapshotting it once at activation.
 */

import z from '@deepseek-ai/schemastery'

/** One provider/model route configured for a preset. */
const PresetRoute = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
})

/**
 * Runtime configuration.
 *
 * An absent or empty map keeps the plugin inert: sessions of the presets then
 * start on the deployment default, exactly as without this plugin.
 */
export const Config = z.object({
  presets: z.dict(PresetRoute).default({}).volatile(),
})

/**
 * Read one Config field, tolerating a plain value when the schema is parsed
 * without the volatile wrapper (tests, older readers).
 *
 * @param {unknown} value Stored field value or volatile reference.
 * @param {unknown} fallback Value when nothing usable is stored.
 * @returns {unknown} the stored value.
 */
export function live(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const current = value.get()
      return current === undefined ? fallback : current
    } catch {
      return fallback
    }
  }
  return value === undefined ? fallback : value
}

/**
 * Unwrap volatile references into the plain shape the request listener uses.
 *
 * Call it on every use, not once at activation: the Configure page may replace
 * the map between two model requests.
 *
 * @param {unknown} raw Plugin Config with optional volatile references.
 * @returns {{ presets: Record<string, unknown> }} the live route map.
 */
export function snapshot(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const presets = live(source.presets, {})
  return { presets: presets !== null && typeof presets === 'object' ? presets : {} }
}
