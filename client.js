/**
 * dsh-dev-presets — Settings section for the per-preset default model routes.
 *
 * The page registers into `settings.section` as its own Settings entry, so the
 * route map is configured where the deployment's other settings live. It reads
 * the model catalog from the Host route `/dev-presets/models` and writes the
 * volatile `presets` map through the Settings form, so a change applies without
 * a restart.
 */

window.__ModuleLoader__.load({
  id: 'dsh-dev-presets',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'devPresets'
    /** Settings section id; the nav label comes from `nav`. */
    const SECTION_ID = 'dev-presets'
    /** Nav position: right after the shipped agent-presets section. */
    const SECTION_ORDER = 20.5
    /** Settings namespaces the Host may serve for this plugin (row id, entry id, package name). */
    const NAMESPACES = ['dev-presets-model', 'include:dev-presets-model', 'dsh-dev-presets']
    /** Host route serving the live model catalog. */
    const MODELS_PATH = '/dev-presets/models'
    /** Presets with a one-line role in the shipped roster; extra configured ids still render. */
    const PRESETS = ['architect', 'implementer', 'reviewer']

    const en = {
      nav: 'Development Presets',
      title: 'Default model per preset',
      intro:
        'Switching a session to a preset with a route below also switches its model, and a session created on that preset starts on it. A later explicit model choice in the composer or /model overrides it, and the automatic switch leaves the deployment default model unchanged. Changes apply without a restart.',
      provider: 'Provider',
      model: 'Model',
      effort: 'Reasoning effort',
      effortDefault: 'Provider default',
      notConfigured: 'Not configured',
      clear: 'Clear',
      saving: 'Saving…',
      saved: 'Saved.',
      saveFailed: 'The change was not saved.',
      unavailable: 'This Host does not serve the configuration form.',
      loading: 'Loading the model catalog…',
      catalogFailed: 'The model catalog could not be read.',
      defaultRoute: 'Deployment default',
      failures: 'Providers that could not be listed:',
      readOnly: 'This profile stores settings read-only.',
      note: 'An unavailable route logs a warning and the current model is kept.',
      presetArchitect: 'Architect',
      presetImplementer: 'Implementer',
      presetReviewer: 'Reviewer',
    }

    const ru = {
      nav: 'Пресеты разработки',
      title: 'Модель по умолчанию для пресета',
      intro:
        'Переключение сессии на пресет с маршрутом ниже также переключает её модель, а сессия, созданная на таком пресете, начинается с неё. Явный выбор модели в композере или /model важнее и применяется после этого, а автоматическое переключение не меняет глобальную модель по умолчанию. Изменения действуют без перезапуска.',
      provider: 'Провайдер',
      model: 'Модель',
      effort: 'Уровень рассуждений',
      effortDefault: 'По умолчанию у провайдера',
      notConfigured: 'Не настроено',
      clear: 'Очистить',
      saving: 'Сохранение…',
      saved: 'Сохранено.',
      saveFailed: 'Изменение не сохранено.',
      unavailable: 'Этот Host не предоставляет форму настройки.',
      loading: 'Загрузка каталога моделей…',
      catalogFailed: 'Не удалось прочитать каталог моделей.',
      defaultRoute: 'Глобальный дефолт',
      failures: 'Провайдеры, которые не удалось получить:',
      readOnly: 'Профиль хранит настройки только для чтения.',
      note: 'Недоступный маршрут пишет предупреждение, и текущая модель сохраняется.',
      presetArchitect: 'Архитектор',
      presetImplementer: 'Исполнитель',
      presetReviewer: 'Ревьюер',
    }

    const CSS = `
.dp-page { display: flex; flex-direction: column; gap: 12px; max-width: 720px; }
.dp-title { font-size: 15px; font-weight: 600; margin: 0; }
.dp-intro { margin: 0; line-height: 1.45; opacity: 0.82; }
.dp-rows { display: flex; flex-direction: column; gap: 10px; }
.dp-row { border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.dp-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dp-row-name { font-weight: 600; }
.dp-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.dp-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dp-label { font-size: 12px; opacity: 0.72; }
.dp-select { width: 100%; min-width: 0; }
.dp-status { font-size: 12px; opacity: 0.8; min-height: 1.2em; }
.dp-error { color: #c2410c; }
.dp-actions { display: flex; gap: 8px; align-items: center; }
.dp-button { font: inherit; padding: 3px 10px; border-radius: 7px; border: 1px solid color-mix(in srgb, currentColor 24%, transparent); background: transparent; color: inherit; cursor: pointer; }
.dp-button:disabled { opacity: 0.5; cursor: default; }
.dp-failures { font-size: 12px; opacity: 0.8; }
`

    /** Observe one form controller: its snapshot plus later replacements. */
    function useFormState(form) {
      const read = React.useCallback(
        () => (form === undefined ? { status: 'unavailable' } : form.getSnapshot()),
        [form],
      )
      const [state, setState] = React.useState(read)
      React.useEffect(() => {
        setState(read())
        if (form === undefined || typeof form.subscribe !== 'function') return undefined
        return form.subscribe(() => setState(read()))
      }, [form, read])
      return state
    }

    /** Write the complete map; the settings service validates it against the Config schema. */
    function writeMap(form, map) {
      if (form === undefined) return Promise.resolve(false)
      if (typeof form.set === 'function') return form.set('presets', map)
      if (typeof form.mutate === 'function') {
        return form.mutate([{ op: 'set', path: ['presets'], value: map }])
      }
      return Promise.resolve(false)
    }

    /** One preset's route editor. */
    function PresetRow({ t, preset, label, entry, groups, writable, onChange }) {
      const providerId = entry?.provider ?? ''
      const group = groups.find((item) => item.id === providerId)
      const models = group?.models ?? []
      const modelId = entry?.model ?? ''
      const model = models.find((item) => item.id === modelId)
      const efforts = model?.reasoning?.efforts ?? []
      const effort = entry?.reasoningEffort ?? ''

      // Keep a configured provider/model visible even when the catalog no
      // longer lists it, so the selectors never look like they reset.
      const providerOptions =
        providerId !== '' && !groups.some((item) => item.id === providerId)
          ? [{ id: providerId, name: providerId }, ...groups]
          : groups
      const modelOptions =
        modelId !== '' && !models.some((item) => item.id === modelId)
          ? [{ id: modelId, name: modelId }, ...models]
          : models

      const onProvider = (next) => {
        // A provider alone is a partial selection: keep it in the draft until
        // a model is chosen. Clearing the provider persists the removal.
        if (next === '') return onChange(preset, undefined, true)
        onChange(preset, { provider: next, model: '', reasoningEffort: '' }, false)
      }
      const onModel = (next) => {
        if (next === '') return onChange(preset, undefined, true)
        const picked = models.find((item) => item.id === next)
        onChange(
          preset,
          { provider: providerId, model: next, reasoningEffort: picked?.reasoning?.defaultEffort ?? '' },
          true,
        )
      }
      const onEffort = (next) => {
        onChange(preset, { provider: providerId, model: modelId, reasoningEffort: next }, modelId !== '')
      }

      return h(
        'div',
        { className: 'dp-row' },
        h(
          'div',
          { className: 'dp-row-head' },
          h('span', { className: 'dp-row-name' }, label),
          providerId === '' ? h('span', { className: 'dp-status' }, t('notConfigured')) : null,
        ),
        h(
          'div',
          { className: 'dp-grid' },
          h(
            'label',
            { className: 'dp-field' },
            h('span', { className: 'dp-label' }, t('provider')),
            h(
              'select',
              {
                className: 'dp-select',
                value: providerId,
                disabled: !writable,
                onChange: (event) => onProvider(event.target.value),
              },
              h('option', { value: '' }, '—'),
              ...providerOptions.map((item) => h('option', { key: item.id, value: item.id }, item.name ?? item.id)),
            ),
          ),
          h(
            'label',
            { className: 'dp-field' },
            h('span', { className: 'dp-label' }, t('model')),
            h(
              'select',
              {
                className: 'dp-select',
                value: modelId,
                disabled: !writable || providerId === '',
                onChange: (event) => onModel(event.target.value),
              },
              h('option', { value: '' }, '—'),
              ...modelOptions.map((item) => h('option', { key: item.id, value: item.id }, item.name ?? item.id)),
            ),
          ),
          h(
            'label',
            { className: 'dp-field' },
            h('span', { className: 'dp-label' }, t('effort')),
            h(
              'select',
              {
                className: 'dp-select',
                value: effort,
                disabled: !writable || modelId === '' || efforts.length === 0,
                onChange: (event) => onEffort(event.target.value),
              },
              h('option', { value: '' }, t('effortDefault')),
              ...efforts.map((item) => h('option', { key: item.id, value: item.id }, item.name ?? item.id)),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dp-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dp-button',
              disabled: !writable || (entry === undefined && providerId === ''),
              onClick: () => onChange(preset, undefined, true),
            },
            t('clear'),
          ),
        ),
      )
    }

    /** Compare a draft route with a persisted one; null and undefined both mean "no route". */
    function sameRoute(left, right) {
      const normalized = (value) => (value === null ? undefined : value)
      const normalizedLeft = normalized(left)
      const normalizedRight = normalized(right)
      if (normalizedLeft === undefined || normalizedRight === undefined) {
        return normalizedLeft === normalizedRight
      }
      return (
        normalizedLeft.provider === normalizedRight.provider &&
        normalizedLeft.model === normalizedRight.model &&
        (normalizedLeft.reasoningEffort ?? '') === (normalizedRight.reasoningEffort ?? '')
      )
    }

    /** Stable empty map so the persisted-route dependency stays stable. */
    const NO_ROUTES = {}

    /** The Settings section body. */
    function Section(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => en[key] ?? key
      const form = props.ownForm
      const state = useFormState(form)
      const [catalog, setCatalog] = React.useState(null)
      const [catalogState, setCatalogState] = React.useState('loading')
      const [draft, setDraft] = React.useState({})
      const [save, setSave] = React.useState('')

      const persisted = React.useMemo(() => {
        const value = state.value
        const map = value !== null && typeof value === 'object' ? value.presets : undefined
        return map !== null && typeof map === 'object' ? map : NO_ROUTES
      }, [state.value])

      // Drop a draft once the Host echoes the saved route back; a draft that is
      // still unsaved, or a partial provider selection, stays visible.
      React.useEffect(() => {
        setDraft((previous) => {
          let changed = false
          const rest = { ...previous }
          for (const preset of Object.keys(previous)) {
            if (sameRoute(previous[preset], persisted[preset])) {
              delete rest[preset]
              changed = true
            }
          }
          return changed ? rest : previous
        })
      }, [persisted])

      React.useEffect(() => {
        let alive = true
        fetch(MODELS_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((payload) => {
            if (!alive) return
            setCatalog(payload)
            setCatalogState('ready')
          })
          .catch(() => {
            if (alive) setCatalogState('failed')
          })
        return () => {
          alive = false
        }
      }, [])

      if (form === undefined || state.status === 'loading') {
        return h('div', { className: 'dp-page' }, h('div', { className: 'dp-status' }, t('loading')))
      }
      if (state.status === 'unavailable' || typeof state.value !== 'object' || state.value === null) {
        return h('div', { className: 'dp-page' }, h('div', { className: 'dp-status' }, t('unavailable')))
      }

      const writable = state.writable === true
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
      const configured = Object.keys(persisted).length
      const ids = [...PRESETS, ...Object.keys(persisted).filter((id) => !PRESETS.includes(id))]

      const effective = (id) =>
        Object.hasOwn(draft, id) ? (draft[id] ?? undefined) : persisted[id]

      const change = async (preset, entry, persist) => {
        // The draft keeps partial selections too: choosing a provider is a
        // step towards a route, not a reason to fall back to the persisted map.
        // A cleared route is held as null until the Host echoes the removal.
        setDraft((previous) => {
          const rest = { ...previous }
          rest[preset] = entry === undefined ? null : entry
          return rest
        })
        if (!persist || !writable) return

        const complete =
          entry !== undefined &&
          typeof entry.provider === 'string' &&
          entry.provider !== '' &&
          typeof entry.model === 'string' &&
          entry.model !== ''
        const clean = complete
          ? {
              provider: entry.provider,
              model: entry.model,
              ...(entry.reasoningEffort === undefined || entry.reasoningEffort === ''
                ? {}
                : { reasoningEffort: entry.reasoningEffort }),
            }
          : undefined

        const next = { ...persisted }
        if (clean === undefined) delete next[preset]
        else next[preset] = clean
        setSave('saving')
        const ok = await writeMap(form, next)
        setSave(ok ? 'saved' : 'failed')
      }

      const defaultRoute =
        catalog?.default !== null && catalog?.default !== undefined
          ? `${catalog.default.provider} / ${catalog.default.model}`
          : '—'

      return h(
        'div',
        { className: 'dp-page' },
        h('style', null, CSS),
        h('h2', { className: 'dp-title' }, t('title')),
        h('p', { className: 'dp-intro' }, t('intro')),
        writable ? null : h('div', { className: 'dp-status dp-error' }, t('readOnly')),
        catalogState === 'loading'
          ? h('div', { className: 'dp-status' }, t('loading'))
          : catalogState === 'failed'
            ? h('div', { className: 'dp-status dp-error' }, t('catalogFailed'))
            : h(
                'div',
                { className: 'dp-rows' },
                ...ids.map((preset) =>
                  h(PresetRow, {
                    key: preset,
                    t,
                    preset,
                    label: t(`preset${preset.charAt(0).toUpperCase()}${preset.slice(1)}`),
                    entry: effective(preset),
                    groups,
                    writable,
                    onChange: change,
                  }),
                ),
              ),
        h(
          'div',
          { className: 'dp-status', role: 'status' },
          save === '' ? '' : t(save === 'saved' ? 'saved' : save === 'saving' ? 'saving' : 'saveFailed'),
        ),
        h('div', { className: 'dp-status' }, `${t('defaultRoute')}: ${defaultRoute} · ${configured}/${ids.length}`),
        Array.isArray(catalog?.failures) && catalog.failures.length > 0
          ? h(
              'div',
              { className: 'dp-failures' },
              `${t('failures')} ${catalog.failures.map((failure) => failure.name ?? failure.id).join(', ')}`,
            )
          : null,
        h('div', { className: 'dp-status' }, t('note')),
      )
    }

    /** Required services: slots, locale, and the settings form provider. */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Register the dictionaries and the Settings section while the Host serves
     * this plugin's configuration namespace.
     *
     * @param {object} ctx Browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'dev-presets: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.effect(
        () =>
          ctx.configForms.whileServed(NAMESPACES, (served) => {
            const namespace = NAMESPACES.find((candidate) => served.has(candidate))
            if (namespace === undefined) return () => {}
            const form = ctx.configForms.get(namespace)
            return ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: SECTION_ID,
                  order: SECTION_ORDER,
                  label: () => t('nav'),
                  locale: NS,
                  inject: () => ({ ownForm: form }),
                },
                Section,
              ),
            )
          }),
        'dev-presets: settings section',
      )
    }

    return { inject, apply }
  },
})
