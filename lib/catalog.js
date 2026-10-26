/**
 * dsh-dev-presets — the browser model catalog for the Configure page.
 *
 * The page lists the deployment's routable providers, models, and reasoning
 * efforts; the Host builds that view from the live LLM registry, the same data
 * the composer's own model picker shows.
 */

/**
 * Build the provider-grouped catalog, isolating a failing provider instead of
 * failing the whole page.
 *
 * @param {object} ctx Host context carrying the `llm` service.
 * @returns {Promise<{
 *   default: { provider: string, model: string, reasoningEffort?: string } | null,
 *   routableProviders: string[],
 *   groups: Array<{ id: string, name: string, models: Array<object> }>,
 *   failures: Array<{ id: string, name: string, message: string }>,
 * }>} the catalog view.
 */
export async function buildModelCatalog(ctx) {
  const llm = ctx.get?.('llm') ?? ctx.llm
  const defaults = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
  const selection =
    typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : undefined

  if (llm === undefined || typeof llm.listProviders !== 'function') {
    return {
      default: selection === undefined ? null : { ...selection },
      routableProviders: [],
      groups: [],
      failures: [],
    }
  }

  const providers = llm.listProviders()
  const entries = await Promise.all(
    providers.map(async (provider) => {
      try {
        const models = await llm.listModels(provider.id)
        const rows = await Promise.all(
          models.map(async (model) => {
            const resolved = await llm.resolveModelInfo(provider.id, model.id)
            const reasoning =
              resolved.reasoning === undefined
                ? undefined
                : {
                    efforts: resolved.reasoning.efforts.map((effort) => ({
                      id: effort.id,
                      name: effort.name,
                      ...(effort.description === undefined
                        ? {}
                        : { description: effort.description }),
                    })),
                    ...(resolved.reasoning.defaultEffort === undefined
                      ? {}
                      : { defaultEffort: resolved.reasoning.defaultEffort }),
                  }
            return {
              id: model.id,
              name: model.name,
              ...(model.description === undefined ? {} : { description: model.description }),
              ...(reasoning === undefined ? {} : { reasoning }),
            }
          }),
        )
        return { kind: 'group', group: { id: provider.id, name: provider.name, models: rows } }
      } catch (error) {
        return {
          kind: 'failure',
          failure: {
            id: provider.id,
            name: provider.name,
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }),
  )

  const groups = entries
    .flatMap((entry) => (entry.kind === 'group' ? [entry.group] : []))
    .filter((group) => group.models.length > 0)

  return {
    default: selection === undefined ? null : { ...selection },
    routableProviders: groups.map((group) => group.id),
    groups,
    failures: entries.flatMap((entry) => (entry.kind === 'failure' ? [entry.failure] : [])),
  }
}
