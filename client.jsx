import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { BUILDING_LOOP_PROJECT_REMOTE } from './governance/project-remote.mjs'

export const name = 'dsh-building-loop-client'
export const inject = ['slots', 'remote', 'sessions']

const CSS = `
.dsh-bl-chip,.dsh-bl-panel{box-sizing:border-box;color:var(--dsw-alias-label-primary,inherit)}
.dsh-bl-chip{display:inline-flex;align-items:center;gap:5px;flex:none;height:26px;padding:2px 8px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.dsh-bl-chip:hover,.dsh-bl-chip[aria-expanded="true"]{background:var(--dsw-alias-button-floating-fill,rgba(128,128,128,.14));color:var(--dsw-alias-label-primary,inherit)}
.dsh-bl-dot{display:block;width:5px;height:5px;border-radius:50%;background:#57b9af;flex:none}
.dsh-bl-panel{position:fixed;z-index:2147483000;width:360px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;overscroll-behavior:contain;padding:15px 16px 16px;border:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:12px;background:var(--dsw-alias-background-primary,#fff);color:var(--dsw-alias-label-primary,#222);box-shadow:0 8px 32px rgba(0,0,0,.24);font:inherit;font-size:13px;line-height:1.5}
body[data-ds-dark-theme] .dsh-bl-panel{background:var(--dsw-static-neutral-850,#252525);color:var(--dsw-alias-label-primary,#eee)}
.dsh-bl-panel:focus{outline:none}
.dsh-bl-panel *{box-sizing:border-box}
.dsh-bl-head,.dsh-bl-setting,.dsh-bl-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsh-bl-head h2{margin:0;font-size:15px;line-height:1.35;font-weight:650}
.dsh-bl-close{display:grid;place-items:center;width:28px;height:28px;flex:none;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer}
.dsh-bl-close::before,.dsh-bl-close::after{grid-area:1/1;width:11px;height:1.3px;border-radius:1px;background:currentColor;content:""}
.dsh-bl-close::before{transform:rotate(45deg)}
.dsh-bl-close::after{transform:rotate(-45deg)}
.dsh-bl-close:hover,.dsh-bl-quiet:hover{background:var(--dsw-alias-button-floating-fill,rgba(128,128,128,.12))}
.dsh-bl-setting{margin-top:9px}
.dsh-bl-setting strong{display:block;font-weight:600}
.dsh-bl-muted{margin:2px 0 0;color:var(--dsw-alias-label-secondary,inherit);font-size:12px;line-height:1.5}
.dsh-bl-switch{display:inline-flex;align-items:center;width:36px;height:21px;flex:none;padding:2px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.32));border-radius:999px;background:var(--dsw-alias-button-floating-fill,rgba(128,128,128,.22));cursor:pointer}
.dsh-bl-switch::before{display:block;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.26);content:""}
.dsh-bl-switch[aria-checked="true"]{justify-content:flex-end;background:var(--dsw-alias-state-business-primary,#157e82);border-color:transparent}
.dsh-bl-workspace{margin:13px 0 0;padding-top:11px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28))}
.dsh-bl-workspace span,.dsh-bl-summary dd,.dsh-bl-feedback{overflow-wrap:anywhere}
.dsh-bl-workspace span{display:block;margin-top:2px;font-size:12px}
.dsh-bl-summary{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 9px;margin:10px 0 0;font-size:12px}
.dsh-bl-summary dt{color:var(--dsw-alias-label-secondary,inherit)}
.dsh-bl-summary dd{margin:0}
.dsh-bl-form{display:grid;gap:9px;margin-top:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28))}
.dsh-bl-field{display:grid;gap:4px;font-size:12px}
.dsh-bl-field input,.dsh-bl-field textarea{display:block;width:100%;min-height:32px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.33));border-radius:6px;background:var(--dsw-alias-button-floating-fill,rgba(128,128,128,.07));color:inherit;font:inherit;line-height:1.45}
.dsh-bl-field textarea{min-height:44px;resize:vertical}
.dsh-bl-field input::placeholder,.dsh-bl-field textarea::placeholder{color:var(--dsw-alias-label-secondary,#686868);opacity:1}
.dsh-bl-path{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:start}
.dsh-bl-picker{display:grid;gap:8px;margin-top:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28))}
.dsh-bl-picker-path{margin:0;overflow-wrap:anywhere;font-size:12px}
.dsh-bl-picker ul{display:grid;gap:2px;max-height:min(230px,42vh);overflow:auto;margin:0;padding:2px;list-style:none}
.dsh-bl-picker li button{width:100%;min-height:30px;padding:4px 7px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;overflow-wrap:anywhere;cursor:pointer}
.dsh-bl-picker li button:hover{background:var(--dsw-alias-button-floating-fill,rgba(128,128,128,.12))}
.dsh-bl-picker small{color:var(--dsw-alias-label-secondary,inherit)}
.dsh-bl-actions{align-items:flex-start;justify-content:flex-end}
.dsh-bl-apply,.dsh-bl-quiet{min-height:32px;padding:5px 11px;border-radius:7px;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
.dsh-bl-apply{border:0;background:#137578;color:white;font-weight:600}
.dsh-bl-apply:hover{background:#105f63}
.dsh-bl-quiet{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:transparent;color:inherit}
.dsh-bl-panel button:disabled,.dsh-bl-field input:disabled,.dsh-bl-field textarea:disabled{opacity:.54;cursor:default}
.dsh-bl-chip:focus-visible,.dsh-bl-panel :is(button,input,textarea):focus-visible{outline:2px solid var(--dsw-focus-ring-color,#1f858a);outline-offset:2px}
.dsh-bl-feedback{margin:10px 0 0;font-size:12px}
.dsh-bl-feedback[role="alert"]{color:var(--dsw-alias-state-danger-primary,#b53f32)}
body[data-ds-dark-theme] .dsh-bl-feedback[role="alert"]{color:var(--dsw-alias-state-danger-primary,#f28f83)}
@media(max-width:700px){.dsh-bl-chip{padding-inline:6px}.dsh-bl-panel{padding-inline:13px}}
`

const EMPTY_FORM = {
  goalFile: 'PROJECT-GOAL.md',
  goalDescription: '',
  candidateFile: 'DELIVERY.md',
  evidencePaths: '',
}

const RESERVED_ROOT = new Set(['.git', '.building-loop', 'building-loop.json'])

function readResult(result) {
  // Typed remotes wrap successful business data and transport errors separately.
  if (!result?.ok) throw new Error(result?.error?.message || '无法读取项目协作设置。')
  const value = result.value
  if (!value || typeof value.enabled !== 'boolean') throw new Error('DSH 返回了无法识别的项目协作设置。')
  return value
}

function ProjectSummary({ state }) {
  return <dl className="dsh-bl-summary">
    {state.goalFile && <><dt>项目总纲</dt><dd>{state.goalFile}</dd></>}
    {state.candidateFile && <><dt>待验收稿</dt><dd>{state.candidateFile}</dd></>}
    <dt>证据文件</dt><dd>{state.evidencePaths?.length ? state.evidencePaths.join('、') : '未添加'}</dd>
  </dl>
}

/** Browse only file names through DSH's existing, session-scoped workspace listing. */
function WorkspacePicker({ list, choose, close }) {
  const [directory, setDirectory] = useState('')
  const [filter, setFilter] = useState('')
  const [listing, setListing] = useState(null)
  const [error, setError] = useState('')
  const search = useRef(null)
  useEffect(() => { search.current?.focus() }, [])
  useEffect(() => {
    const controller = new AbortController()
    setListing(null)
    setError('')
    const load = async () => {
      try {
        const result = await list(directory, controller.signal)
        if (!result?.ok) throw new Error(result?.error?.message || '无法浏览工作区文件。')
        if (!controller.signal.aborted) setListing(result.value)
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason.message)
      }
    }
    void load()
    return () => controller.abort()
  }, [directory, list])

  const navigate = path => { setFilter(''); setDirectory(path) }
  const query = filter.trim().toLowerCase()
  const entries = listing?.entries.filter(entry => {
    // Only simple basenames from the native response may be joined to the selected directory.
    if (typeof entry.name !== 'string' || !entry.name || entry.name === '.' || entry.name === '..' || /[\\/:\r\n]/u.test(entry.name)) return false
    const foldedName = entry.name.toLowerCase()
    if (!directory && RESERVED_ROOT.has(foldedName)) return false
    return !entry.symlink && (entry.type === 'directory' || entry.type === 'file') && foldedName.includes(query)
  }) || []
  const ordered = [...entries.filter(entry => entry.type === 'directory'), ...entries.filter(entry => entry.type === 'file')]

  return <div className="dsh-bl-picker">
    <div className="dsh-bl-actions">
      {directory && <button type="button" className="dsh-bl-quiet" onClick={() => navigate(directory.split('/').slice(0, -1).join('/'))}>上一级</button>}
      <button type="button" className="dsh-bl-quiet" onClick={close}>返回设置</button>
    </div>
    <p className="dsh-bl-picker-path">{directory || '工作区根目录'}</p>
    <label className="dsh-bl-field">查找当前目录
      <input ref={search} value={filter} onChange={event => setFilter(event.target.value)} />
    </label>
    {error && <p className="dsh-bl-feedback" role="alert">{error} 可以返回设置填写相对路径。</p>}
    {!listing && !error && <p className="dsh-bl-feedback" role="status">正在读取文件列表…</p>}
    {listing && ordered.length === 0 && <p className="dsh-bl-feedback" role="status">没有可选文件或目录。</p>}
    {listing && ordered.length > 0 && <ul aria-label="工作区文件与文件夹">
      {ordered.map(entry => {
        const path = [directory, entry.name].filter(Boolean).join('/')
        return <li key={entry.name}>
          <button type="button" onClick={() => entry.type === 'directory' ? navigate(path) : choose(path)}>
            {entry.name}{entry.type === 'directory' && <small>　文件夹</small>}
          </button>
        </li>
      })}
    </ul>}
    {listing?.truncated && <small>当前目录文件较多。可以进入子目录或直接填写相对路径。</small>}
  </div>
}

function SetupForm({ saving, onSubmit, list }) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [picker, setPicker] = useState(null)
  const fieldId = useId()
  const buttons = useRef({})
  const returnFocus = useRef(null)
  useEffect(() => {
    if (!picker && returnFocus.current) {
      buttons.current[returnFocus.current]?.focus()
      returnFocus.current = null
    }
  }, [picker])
  const update = key => ({
    value: form[key],
    onChange: event => setForm(current => ({ ...current, [key]: event.target.value })),
  })
  const browse = (key, label) => <button type="button" className="dsh-bl-quiet" disabled={saving}
    ref={node => { buttons.current[key] = node }} aria-label={`浏览${label}`} onClick={() => setPicker(key)}>浏览…</button>
  const leave = () => { returnFocus.current = picker; setPicker(null) }
  if (picker) return <WorkspacePicker list={list} close={leave} choose={path => {
    setForm(current => {
      if (picker !== 'evidencePaths') return { ...current, [picker]: path }
      const paths = new Set(current.evidencePaths.split(/\r?\n/).map(value => value.trim()).filter(Boolean))
      paths.add(path)
      return { ...current, evidencePaths: [...paths].join('\n') }
    })
    leave()
  }} />

  return <form className="dsh-bl-form" onSubmit={event => {
    event.preventDefault()
    event.stopPropagation()
    onSubmit({
      goalFile: form.goalFile.trim(),
      goalDescription: form.goalDescription.trim(),
      candidateFile: form.candidateFile.trim(),
      evidencePaths: form.evidencePaths.split(/\r?\n/).map(path => path.trim()).filter(Boolean),
    })
  }}>
    <p className="dsh-bl-muted">填写相对当前工作区的文件路径。已有文件会直接沿用。</p>
    <div className="dsh-bl-field">
      <label htmlFor={`${fieldId}-goal`}>项目总纲路径</label>
      <div className="dsh-bl-path"><input id={`${fieldId}-goal`} {...update('goalFile')} autoComplete="off" required disabled={saving} maxLength={500} />{browse('goalFile', '项目总纲')}</div>
    </div>
    <label className="dsh-bl-field">
      项目目标（新建总纲时填写）
      <textarea {...update('goalDescription')} rows={2} disabled={saving} maxLength={8000} placeholder="交付什么，怎样算完成？" />
    </label>
    <div className="dsh-bl-field">
      <label htmlFor={`${fieldId}-candidate`}>待验收稿路径</label>
      <div className="dsh-bl-path"><input id={`${fieldId}-candidate`} {...update('candidateFile')} autoComplete="off" required disabled={saving} maxLength={500} />{browse('candidateFile', '待验收稿')}</div>
    </div>
    <div className="dsh-bl-field">
      <label htmlFor={`${fieldId}-evidence`}>证据文件路径（可选，每行一条）</label>
      <div className="dsh-bl-path"><textarea id={`${fieldId}-evidence`} {...update('evidencePaths')} rows={2} disabled={saving} placeholder="例如 data/measurements.csv" />{browse('evidencePaths', '证据文件')}</div>
    </div>
    <div className="dsh-bl-actions">
      <button type="submit" className="dsh-bl-apply" disabled={saving || !form.goalFile.trim() || !form.candidateFile.trim()}>
        {saving ? '保存中…' : '保存授权并开启'}
      </button>
    </div>
  </form>
}

/** Keep the popover inside the viewport, including when the setup form changes height. */
function usePlacement(open, anchor, panel, dismiss) {
  const [position, setPosition] = useState(null)

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    const placeAt = box => {
      const body = panel.current
      if (!box || !body) return
      const above = box.top - body.offsetHeight - 8
      const left = Math.max(12, Math.min(box.left, window.innerWidth - body.offsetWidth - 12))
      const top = above >= 12 ? above : Math.max(12, Math.min(box.bottom + 8, window.innerHeight - body.offsetHeight - 12))
      setPosition(previous => previous?.left === left && previous?.top === top ? previous : { left, top })
    }
    const place = () => placeAt(anchor.current?.getBoundingClientRect())
    place()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
    if (panel.current) observer?.observe(panel.current)
    if (anchor.current) observer?.observe(anchor.current)
    if (anchor.current?.parentElement) observer?.observe(anchor.current.parentElement)
    // A native sidebar can move the chip without resizing it or issuing another window resize.
    // Read only the anchor between those events, and recompute the panel when its position changes.
    let lastBox
    const followAnchor = window.setInterval(() => {
      const box = anchor.current?.getBoundingClientRect()
      if (box && (!lastBox || box.left !== lastBox.left || box.top !== lastBox.top || box.bottom !== lastBox.bottom)) {
        lastBox = box
        placeAt(box)
      }
    }, 80)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const onPointerDown = event => {
      if (!panel.current?.contains(event.target) && !anchor.current?.contains(event.target)) dismiss()
    }
    const onKeyDown = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      dismiss(true)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      observer?.disconnect()
      window.clearInterval(followAnchor)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, anchor, panel, dismiss])

  const placed = Boolean(position)
  useEffect(() => {
    if (open && placed) panel.current?.focus()
  }, [open, placed, panel])
  return position || { left: 12, top: 12, visibility: 'hidden' }
}

export function ProjectControl({ sessionId, api, listWorkspace }) {
  const [state, setState] = useState(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const anchor = useRef(null)
  const panel = useRef(null)
  const toggle = useRef(null)
  const focusSwitch = useRef(false)
  const latest = useRef(0)
  const read = useRef(null)
  const write = useRef(false)
  const apiRef = useRef(api)
  apiRef.current = api
  const listRef = useRef(listWorkspace)
  listRef.current = listWorkspace
  const list = useCallback((path, signal) => listRef.current(path, signal), [])
  const id = useId()

  const dismiss = useCallback((restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) anchor.current?.focus()
  }, [])
  const position = usePlacement(open, anchor, panel, dismiss)

  const refresh = useCallback(async () => {
    if (write.current || read.current !== null) return
    const request = ++latest.current
    read.current = request
    setPending('read')
    setError('')
    try {
      const next = readResult(await apiRef.current.get({ sessionId }))
      if (latest.current === request) setState(next)
    } catch (reason) {
      if (latest.current === request) setError(reason.message)
    } finally {
      if (read.current === request) read.current = null
      if (latest.current === request) setPending(null)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
    // A preset, directory, or session change remounts the control and invalidates this result.
    return () => { ++latest.current; read.current = null }
  }, [refresh])

  useEffect(() => {
    if (open && !pending && focusSwitch.current) {
      const control = toggle.current?.disabled ? panel.current : toggle.current
      control?.focus()
    }
    if (!pending) focusSwitch.current = false
  }, [open, pending])

  const mutate = async (method, fields) => {
    if (write.current) return
    write.current = true
    const request = ++latest.current
    setPending('write')
    setError('')
    setNotice('')
    try {
      const next = readResult(await apiRef.current[method]({ sessionId, ...fields }))
      if (latest.current !== request) return
      // The setup form unmounts after saving. Keep keyboard focus inside the panel.
      focusSwitch.current = method === 'setup' || state?.status === 'invalid'
      setState(next)
      if (next.enabled) setNotice('已为当前会话开启项目协作。')
      else if (method === 'set') setNotice('已为当前会话关闭项目协作。')
    } catch (reason) {
      if (latest.current === request) setError(reason.message)
    } finally {
      write.current = false
      if (latest.current === request) setPending(null)
    }
  }

  const ready = state?.status === 'ready'
  const missing = state?.status === 'missing'
  const canDisable = state?.status === 'invalid' && state.canDisable
  const enabled = state?.enabled === true
  const saving = pending === 'write'
  const busy = pending !== null

  return <>
    <button ref={anchor} type="button" className="dsh-bl-chip" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} aria-label={`项目协作${enabled ? '，已开启' : ''}`}
      onClick={() => {
        if (open) { dismiss(); return }
        setOpen(true)
        setNotice('')
        void refresh()
      }}>
      {enabled && <span className="dsh-bl-dot" aria-hidden="true" />}
      项目协作
    </button>
    {open && createPortal(<section id={id} ref={panel} className="dsh-bl-panel" style={position} tabIndex={-1}
      role="dialog" aria-labelledby={`${id}-title`} aria-busy={busy}
      onKeyDown={event => { if (event.key === 'Enter') event.stopPropagation() }}>
      <div className="dsh-bl-head">
        <h2 id={`${id}-title`}>项目协作</h2>
        <button type="button" className="dsh-bl-close" aria-label="关闭项目协作面板" onClick={() => dismiss(true)} />
      </div>
      <div className="dsh-bl-setting">
        <div>
          <strong id={`${id}-switch`}>仅此会话</strong>
          <p className="dsh-bl-muted" id={`${id}-help`}>{missing ? '普通聊天可以直接发送。需要派单时，先选项目文件。' : '开启后可派单、核验资料和记账。'}</p>
        </div>
        <button ref={toggle} type="button" role="switch" className="dsh-bl-switch" aria-checked={enabled}
          aria-labelledby={`${id}-switch`} aria-describedby={`${id}-help`}
          disabled={busy || (!ready && !enabled)} onClick={() => void mutate('set', { enabled: !enabled })} />
      </div>
      {state?.workspace && <p className="dsh-bl-workspace"><strong>工作区</strong><span>{state.workspace}</span></p>}
      {ready && <ProjectSummary state={state} />}
      {missing && <SetupForm saving={busy} list={list} onSubmit={fields => void mutate('setup', fields)} />}
      {state?.message && <p className="dsh-bl-feedback" role={ready ? 'status' : 'alert'}>{state.message}</p>}
      {canDisable && <div className="dsh-bl-actions"><button type="button" className="dsh-bl-quiet" disabled={busy} onClick={() => void mutate('set', { enabled: false })}>关闭协作，继续聊天</button></div>}
      {pending === 'read' && !state && <p className="dsh-bl-feedback" role="status">正在读取项目协作设置…</p>}
      {error && <p className="dsh-bl-feedback" role="alert">{error}</p>}
      {error && !state && <div className="dsh-bl-actions"><button type="button" className="dsh-bl-quiet" disabled={busy} onClick={() => void refresh()}>重新读取</button></div>}
      {notice && <p className="dsh-bl-feedback" role="status">{notice}</p>}
    </section>, document.body)}
  </>
}

export function ProjectEntry({ sessionId, sessions, api, inherited, listWorkspace }) {
  const snapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot)
  const session = snapshot.byId[sessionId]
  const preset = session?.projectionValues?.agentPreset
  if (!sessionId || inherited || (preset !== 'building-loop' && preset !== 'paidan')) return null
  // Reset form and pending UI responses when the native draft is reused for a different workspace or preset.
  return <ProjectControl key={JSON.stringify([sessionId, session.cwd, preset])} sessionId={sessionId} api={api} listWorkspace={listWorkspace} />
}

/** Mount after Sup in the same composer slot. The native slot supplies draft and started session IDs. */
export async function apply(ctx) {
  // The contribution declares its own Remote namespace, so it can only be injected after mounting the codec.
  await ctx.remote.$mount(BUILDING_LOOP_PROJECT_REMOTE)
  let workspaceFiles
  // Some renderers lack the native file browser. Keep the settings chip active and connect browsing only where available.
  ctx.inject(['remote.workspaceFiles'], scope => {
    scope.effect(() => {
      const service = scope.remote.workspaceFiles
      workspaceFiles = service
      return () => { if (workspaceFiles === service) workspaceFiles = undefined }
    }, 'building-loop: native workspace browser')
  })
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.pluginCss = name
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'building-loop: composer styles')
  ctx.inject(['remote.buildingLoopProject'], scope => {
    scope.slots.inject('conversation.input.left', () => scope.slots.register({
      name: 'conversation.input.left',
      id: 'dsh-building-loop-project',
      order: 72,
      inject: sessionId => ({
        sessions: scope.sessions.list,
        api: scope.remote.buildingLoopProject,
        inherited: scope.sessions.subagentAddress(sessionId) !== undefined,
        listWorkspace: (path, signal) => {
          if (typeof workspaceFiles?.list !== 'function') throw new Error('当前 DSH 未提供工作区文件浏览。')
          // The native listing requires a nonempty path, including when browsing the workspace root.
          return workspaceFiles.list(sessionId, path || '.', signal)
        },
      }),
    }, ProjectEntry))
  })
}

export default { name, inject, apply }
