'use client'
// Modelos → Rutas: model aliases (lib/model-aliases.js, ADR-0015). A route
// is a name an application or an agent asks for ("stratum/rapido") and the
// models it goes to, in order: the first one the team's policy allows, and
// the next while a provider fails.

import { useState } from 'react'
import Modal, { Field, Input, Btn } from '../../components/Modal'
import { allowedBy } from '../../lib/catalog'
import { KINDS, KIND_LABELS, kindOf } from '../../lib/model-kind'

const MAX = 4
const formatOf = (provider) => (provider === 'anthropic' ? 'anthropic' : 'openai')
const keyOf = (t) => `${t.provider}/${t.model}`
const TYPED_RE = /^[a-z0-9][a-z0-9-]*\/.+/

function AliasModal({ alias, options, onClose, onSaved }) {
  // A route's models are of one kind (lib/model-kind.js): what a model
  // outside the list is, its ID says.
  const kindOfTarget = (t) => options.find(o => keyOf(o) === keyOf(t))?.kind ?? kindOf(t.model)
  const editing = Boolean(alias)
  const [name, setName] = useState(alias?.name ?? '')
  const [description, setDescription] = useState(alias?.description ?? '')
  const [targets, setTargets] = useState(alias?.targets ?? [])
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const [pickedKind, setPickedKind] = useState('chat')
  const kind = targets.length ? kindOfTarget(targets[0]) : pickedKind
  const kinds = KINDS.filter(k => k === 'chat' || options.some(o => o.kind === k))
  const format = targets.length ? formatOf(targets[0].provider) : null
  const choices = options.filter(o => !targets.some(t => keyOf(t) === keyOf(o)) && o.kind === kind &&
    (!format || formatOf(o.provider) === format))

  const move = (i, d) => setTargets(ts => {
    const out = [...ts]
    ;[out[i], out[i + d]] = [out[i + d], out[i]]
    return out
  })

  // A model typed in "Otro": checked, then added (button or Enter).
  function addTyped() {
    const v = typed.trim()
    if (!TYPED_RE.test(v)) return setError('Escribí proveedor/modelo, por ejemplo groq/llama-3.3-70b.')
    const [provider, ...rest] = v.split('/')
    const t = { provider, model: rest.join('/') }
    if (provider === 'stratum') return setError('stratum/… es una ruta, no un modelo.')
    if (targets.some(x => keyOf(x) === keyOf(t))) return setError('Ese modelo ya está en la ruta.')
    if (format && formatOf(provider) !== format) return setError('Anthropic y los demás proveedores usan formatos de API distintos: la ruta va solo a uno de los dos.')
    if (targets.length && kindOfTarget(t) !== kind) return setError(`La ruta es de ${KIND_LABELS[kind].toLowerCase()}: ${v} es de ${KIND_LABELS[kindOfTarget(t)].toLowerCase()}.`)
    setError(''); setTargets(ts => [...ts, t]); setTyped('')
  }

  async function save() {
    // Something typed and not added would be lost without a word: say so.
    if (typed.trim()) return setError(`Agregá ${typed.trim()} con "Agregar este", o borralo, antes de guardar.`)
    setSaving(true); setError('')
    const res = await fetch(editing ? `/api/model-aliases/${encodeURIComponent(alias.name)}` : '/api/model-aliases', {
      method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, targets }),
    })
    const data = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) return setError(data.message ?? 'No se pudo guardar.')
    onSaved()
  }

  return (
    <Modal title={editing ? `Ruta stratum/${alias.name}` : 'Nueva ruta'} onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        {!editing && (
          <Field label="Nombre" hint="Lo que piden las aplicaciones y los agentes: stratum/nombre. Minúsculas, números, punto y guiones.">
            <Input id="alias-name" value={name} onChange={e => setName(e.target.value.toLowerCase())} placeholder="rapido" autoFocus />
          </Field>
        )}
        <Field label="Para qué es" hint="Opcional. Lo ven quienes eligen la ruta.">
          <Input id="alias-description" value={description} onChange={e => setDescription(e.target.value)} placeholder="Respuestas cortas y baratas" />
        </Field>

        <div className="space-y-2">
          <span className="block text-xs font-semibold text-muted uppercase tracking-wide">Modelos, en orden</span>
          {targets.length === 0 && <p className="text-sm text-muted">Elegí el primer modelo abajo.</p>}
          {targets.length === 0 && kinds.length > 1 && (
            <div role="group" aria-label="Tipo de modelo" className="flex flex-wrap gap-1.5">
              {kinds.map(k => (
                <button key={k} type="button" onClick={() => setPickedKind(k)} aria-pressed={kind === k}
                  className={`min-h-[32px] px-3 rounded-full text-xs border ${kind === k
                    ? 'bg-ink border-ink text-white' : 'bg-card border-border-strong text-strong hover:bg-raised'}`}>
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
          )}
          <ol className="space-y-1.5" aria-label="Modelos de la ruta">
            {targets.map((t, i) => (
              <li key={keyOf(t)} className="flex items-center gap-2 text-sm">
                <span className="w-5 text-right text-muted tabular">{i + 1}.</span>
                <span className="flex-1 min-w-0 truncate font-mono text-strong">{keyOf(t)}</span>
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Subir ${keyOf(t)}`} className="px-2 h-8 rounded border border-border disabled:opacity-30">↑</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === targets.length - 1} aria-label={`Bajar ${keyOf(t)}`} className="px-2 h-8 rounded border border-border disabled:opacity-30">↓</button>
                <button type="button" onClick={() => setTargets(ts => ts.filter((_, j) => j !== i))} aria-label={`Quitar ${keyOf(t)}`} className="px-2 h-8 rounded border border-border text-err">✕</button>
              </li>
            ))}
          </ol>
          {targets.length < MAX && (
            <>
            <div className="flex gap-2">
              {/* Choosing a model adds it: no second step to forget. */}
              <label htmlFor="alias-pick" className="sr-only">Modelo para agregar</label>
              <select id="alias-pick" value="" onChange={e => {
                const o = options.find(x => keyOf(x) === e.target.value)
                if (o) { setError(''); setTargets(ts => [...ts, { provider: o.provider, model: o.model }]) }
              }}
                      className="flex-1 min-w-0 bg-card border border-border rounded-lg px-3 h-10 text-sm text-strong">
                <option value="">{targets.length ? 'Si ese falla, probar con…' : 'Elegí un modelo'}</option>
                {choices.map(o => <option key={keyOf(o)} value={keyOf(o)}>{o.name} · {o.provider}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <label htmlFor="alias-typed" className="sr-only">Otro modelo</label>
              <input id="alias-typed" value={typed} onChange={e => setTyped(e.target.value)} placeholder="Otro: proveedor/modelo"
                     onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTyped() } }}
                     className="flex-1 min-w-0 bg-card border border-border-strong rounded-md px-3 h-10 text-sm text-strong placeholder-subtle" />
              <Btn variant="secondary" disabled={!TYPED_RE.test(typed.trim())} onClick={addTyped}>Agregar este</Btn>
            </div>
            </>
          )}
          <p className="text-xs text-subtle">
            Cada pedido va al primer modelo que la política del equipo permite. Si su proveedor falla o está pausado, el
            gateway prueba el siguiente, antes de mandarle nada a la aplicación. Hasta {MAX} modelos, del mismo tipo, y
            todos de Anthropic o todos de los demás proveedores: usan formatos de API distintos.
          </p>
        </div>

        {error && <p className="text-xs text-err bg-err-light rounded-lg px-3 py-2">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="secondary" onClick={onClose}>Cancelar</Btn>
          <Btn disabled={saving || targets.length === 0 || (!editing && !name)} onClick={save}>{saving ? 'Guardando…' : 'Guardar'}</Btn>
        </div>
      </div>
    </Modal>
  )
}

/**
 * aliases: the organization's; catalog: GET /api/models; configured: the
 * providers it connected (null: this role cannot see them); policies: to
 * show which teams can use each route.
 */
export default function Aliases({ aliases, catalog, configured, policies, canManage, onChanged }) {
  const [editing, setEditing] = useState(null) // an alias, or {} for a new one
  const [error, setError] = useState('')
  const options = catalog
    .filter(m => m.enabled !== false && (!configured || configured.some(c => c.provider === m.provider)))
    .map(m => ({ provider: m.provider, model: m.model_id, name: m.display_name, kind: m.kind ?? 'chat' }))

  const teamsFor = (a) => policies.filter(p => a.targets.some(t => {
    const m = catalog.find(c => c.provider === t.provider && (c.model_id === t.model || (c.aliases ?? []).includes(t.model)))
    return allowedBy(p, m ?? { provider: t.provider, model_id: t.model })
  }))

  async function remove(a) {
    setError('')
    const res = await fetch(`/api/model-aliases/${encodeURIComponent(a.name)}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return setError(data.message ?? 'No se pudo borrar.')
    onChanged()
  }

  return (
    <section aria-labelledby="aliases" className="bg-card border border-border rounded-[10px] px-5 py-4 space-y-3" data-testid="aliases">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0 space-y-1">
          <h2 id="aliases" className="text-sm font-semibold text-strong">Rutas</h2>
          <p className="text-sm text-muted max-w-3xl">
            Un nombre que piden las aplicaciones y los agentes (<code className="font-mono text-default">stratum/rapido</code>) y
            los modelos a los que va, en orden: si el proveedor del primero falla, el gateway prueba el siguiente. Cambiar
            los modelos de una ruta cambia el de todas las aplicaciones que la usan, sin tocarlas.
          </p>
        </div>
        {canManage && <Btn onClick={() => setEditing({})}>Nueva ruta</Btn>}
      </div>
      {error && <p role="alert" className="text-xs text-err bg-err-light rounded-md px-3 py-2">{error}</p>}
      {aliases.length === 0 ? (
        <p className="text-sm text-muted">Todavía no hay rutas.</p>
      ) : (
        <ul className="divide-y divide-border">
          {aliases.map(a => {
            const teams = teamsFor(a)
            return (
              <li key={a.name} className="py-3 flex flex-wrap items-start gap-3" data-testid="alias">
                <div className="flex-1 min-w-0 space-y-1">
                  <p className="font-mono text-strong">
                    stratum/{a.name}
                    {(() => {
                      // Shown for a route that is not of chat models.
                      const t = a.targets[0]
                      const k = t && (options.find(o => keyOf(o) === keyOf(t))?.kind ?? kindOf(t.model))
                      return k && k !== 'chat' ? <span className="ml-2 font-sans text-xs text-muted">{KIND_LABELS[k]}</span> : null
                    })()}
                  </p>
                  {a.description && <p className="text-sm text-muted">{a.description}</p>}
                  <p className="text-sm text-default flex flex-wrap items-center gap-1.5">
                    {a.targets.map((t, i) => (
                      <span key={keyOf(t)} className="flex items-center gap-1.5">
                        {i > 0 && <span className="text-subtle" aria-hidden="true">→</span>}
                        <span className="font-mono text-xs bg-raised rounded px-1.5 py-0.5">{keyOf(t)}</span>
                      </span>
                    ))}
                  </p>
                  <p className="text-xs text-subtle">
                    {teams.length ? `Políticas que permiten alguno de sus modelos: ${teams.map(p => p.name).join(', ')}` : 'Ninguna política permite sus modelos todavía.'}
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-2">
                    <Btn variant="secondary" onClick={() => setEditing(a)}>Editar</Btn>
                    <Btn variant="danger" onClick={() => remove(a)} aria-label={`Borrar stratum/${a.name}`}>Borrar</Btn>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {editing && (
        <AliasModal alias={editing.name ? editing : null} options={options}
                    onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged() }} />
      )}
    </section>
  )
}
