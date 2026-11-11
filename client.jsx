import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { BUILDING_LOOP_PROJECT_REMOTE } from './governance/project-remote.mjs'

export const name = 'dsh-building-loop-client'
export const inject = ['slots', 'remote', 'sessions']

const CSS = [
  '.dsh-bl-start{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) * 2 - var(--dsh-composer-dock-inset,8px) * 2);max-width:var(--dsh-composer-card-max-width,48rem);margin:0 auto 6px;flex:none;min-width:0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-module-platform,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font-size:13px;line-height:1.55}',
  '.dsh-bl-start h2{margin:0 0 7px;font-size:14px;line-height:1.4;font-weight:600}',
  '.dsh-bl-start dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;max-block-size:min(30dvh,13rem);margin:0;overflow:auto}',
  '.dsh-bl-start dt{color:var(--dsw-alias-label-secondary,inherit)}',
  '.dsh-bl-start dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-bl-start__actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:11px}',
  '.dsh-bl-start button{box-sizing:border-box;min-height:36px;padding:6px 12px;border:.5px solid transparent;border-radius:var(--dsw-radius-md,8px);font:inherit;font-weight:500;line-height:1.4;cursor:pointer}',
  '.dsh-bl-start__defer{color:inherit;background:transparent}',
  '.dsh-bl-start__primary{color:white;background:var(--dsw-static-deepseek-600,#4868b2)}',
  '.dsh-bl-start__defer:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-bl-start__primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-static-deepseek-600,#4868b2) 90%,black)}',
  'body[data-ds-dark-theme] .dsh-bl-start__primary{color:var(--dsw-static-neutral-bluish-950,#101828);background:var(--dsw-static-deepseek-400,#7aaaff)}',
  'body[data-ds-dark-theme] .dsh-bl-start__primary:hover:not(:disabled){background:var(--dsw-static-deepseek-300,#b7c8fe)}',
  '.dsh-bl-start button:disabled{opacity:.55;cursor:default}',
  '.dsh-bl-start :focus-visible,.dsh-bl-start__notice:focus-visible{outline:2px solid var(--dsw-focus-ring-color,Highlight);outline-offset:2px}',
  '.dsh-bl-start__message,.dsh-bl-start__error,.dsh-bl-start__notice{margin:0;overflow-wrap:anywhere}',
  '.dsh-bl-start__message,.dsh-bl-start__error{margin-top:8px}',
  '.dsh-bl-start__error{color:var(--dsw-alias-state-error-primary,#aa3026)}',
  '.dsh-bl-start__notice{padding:5px 14px;color:var(--dsw-alias-label-primary,CanvasText);font-size:13px;line-height:1.55;text-align:right}',
  '@media(max-width:500px){.dsh-bl-start{padding:10px 12px}.dsh-bl-start dl{gap:4px 8px}.dsh-bl-start button{min-height:44px}}',
].join('\n')

function resultValue(result) {
  if (!result?.ok) throw new Error(result?.error?.message || '无法联系 DSH，请重试。')
  return result.value
}

function readRunning(snapshot) {
  return Boolean(snapshot?.running)
}

function readLastTurn(snapshot) {
  return snapshot?.turnOrder?.at(-1) ?? null
}

function ProposalCard({ proposal, action, error, message, decide, cardRef }) {
  const titleId = useId()
  return (
    <section ref={cardRef} className="dsh-bl-start" aria-labelledby={titleId} aria-busy={Boolean(action)}>
      <h2 id={titleId}>可以开始建设了</h2>
      <dl>
        <dt>目标</dt>
        <dd>{proposal.goal}</dd>
        <dt>交付与验收</dt>
        <dd>{proposal.deliverable}</dd>
        <dt>执行范围</dt>
        <dd>{proposal.scope}</dd>
      </dl>
      {error && <p className="dsh-bl-start__error" role="alert">{error}</p>}
      {!error && message && <p className="dsh-bl-start__message" role="status">{message}</p>}
      <div className="dsh-bl-start__actions">
        <button type="button" className="dsh-bl-start__defer" disabled={Boolean(action)} onClick={() => decide('discuss')}>
          {action === 'discuss' ? '正在处理…' : '先讨论'}
        </button>
        <button type="button" className="dsh-bl-start__primary" disabled={Boolean(action)} onClick={() => decide('start')}>
          {action === 'start' ? '正在开工…' : '开始建设'}
        </button>
      </div>
    </section>
  )
}

/** Observe native turn state so an ordinary chat never acquires a polling loop or a permanent control. */
function ProposalDock({ sessionId, api, useSession }) {
  const running = useSession(readRunning)
  const lastTurn = useSession(readLastTurn)
  const [observed, setObserved] = useState(null)
  const [action, setAction] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const [retryFocus, setRetryFocus] = useState(null)
  const card = useRef(null)
  const notice = useRef(null)
  const mounted = useRef(false)
  const mutation = useRef(null)
  const readEpoch = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    // Clear the previous proposal as soon as a new native turn has started.
    if (running) {
      setObserved(null)
      return
    }
    if (mutation.current) return
    let stopped = false
    let timer
    const epoch = ++readEpoch.current

    async function load(retry) {
      if (stopped || epoch !== readEpoch.current) return
      try {
        const value = resultValue(await api.proposal({ sessionId }))
        if (stopped || epoch !== readEpoch.current) return
        setObserved({ lastTurn, value })
        if (value.status !== 'idle') return
      } catch {
        // A refresh is passive. Transport errors are shown when the user is taking an action.
        if (stopped || epoch !== readEpoch.current) return
      }
      // A bounded second read handles a host proposal reaching disk just after the native turn settles.
      if (retry && lastTurn !== null) timer = window.setTimeout(() => void load(false), 850)
    }

    void load(true)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [api, lastTurn, refresh, running, sessionId])

  useEffect(() => {
    if (!feedback || feedback.level === 'error') return
    if (feedback.restoreFocus && document.activeElement === document.body) notice.current?.focus()
    const timer = window.setTimeout(() => setFeedback(null), 5000)
    return () => window.clearTimeout(timer)
  }, [feedback])

  const pending = !running && observed?.lastTurn === lastTurn && observed.value.status === 'proposed' ? observed.value : null
  const proposal = action?.proposal ?? pending?.proposal
  const error = feedback?.level === 'error' && feedback.proposalId === proposal?.id ? feedback.text : null

  useEffect(() => {
    if (retryFocus && document.activeElement === document.body) {
      card.current?.querySelector('.dsh-bl-start__' + retryFocus)?.focus()
    }
    if (retryFocus) setRetryFocus(null)
  }, [retryFocus])

  async function decide(decision) {
    if (mutation.current || !proposal || running) return
    const request = { decision, proposal }
    const restoreFocus = Boolean(card.current?.contains(document.activeElement))
    mutation.current = request
    ++readEpoch.current
    setAction(request)
    setFeedback(null)
    try {
      const value = resultValue(await api.decide({ sessionId, proposalId: proposal.id, decision }))
      if (!mounted.current || mutation.current !== request) return
      if (value.status !== (decision === 'start' ? 'started' : 'discussing')) {
        throw new Error(value.message || '任务状态已变化，请查看最新对话。')
      }
      setObserved({ lastTurn, value })
      setFeedback({
        level: 'status', restoreFocus,
        text: value.message || (value.status === 'started' ? '已开始建设。' : '继续讨论。'),
      })
    } catch (failure) {
      if (!mounted.current || mutation.current !== request) return
      setFeedback({ level: 'error', proposalId: proposal.id, text: failure.message || '操作失败，请重试。' })
      if (restoreFocus) setRetryFocus(decision === 'start' ? 'primary' : 'defer')
      setRefresh((value) => value + 1)
    } finally {
      if (mutation.current === request) mutation.current = null
      if (mounted.current) setAction(null)
    }
  }

  if (proposal) {
    return <ProposalCard proposal={proposal} action={action?.decision} error={error} message={pending?.message} decide={decide} cardRef={card} />
  }
  if (feedback?.level === 'status') {
    return <p ref={notice} tabIndex={-1} className="dsh-bl-start__notice" role="status">{feedback.text}</p>
  }
  return null
}

export function ProjectEntry({ sessionId, sessions, api, inherited, useSession }) {
  const snapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot)
  const session = snapshot.byId[sessionId]
  const preset = session?.projectionValues?.agentPreset
  if (!sessionId || inherited || (preset !== 'building-loop' && preset !== 'paidan')) return null
  // A native draft can be reused for another workspace or preset. Reset all pending reads and button state.
  return <ProposalDock key={JSON.stringify([sessionId, session.cwd, preset])} sessionId={sessionId} api={api} useSession={useSession} />
}

/** Put the proposal in the same native dock as conversation tasks and queue, directly above the composer. */
export async function apply(ctx) {
  await ctx.remote.$mount(BUILDING_LOOP_PROJECT_REMOTE)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.pluginCss = name
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'building-loop: conversation proposal styles')
  ctx.inject(['remote.buildingLoopProject'], scope => {
    scope.slots.inject('conversation.input.dock', () => scope.slots.register({
      name: 'conversation.input.dock',
      id: 'dsh-building-loop-proposal',
      order: 10,
      inject: sessionId => ({
        sessionId,
        sessions: scope.sessions.list,
        api: scope.remote.buildingLoopProject,
        inherited: scope.sessions.subagentAddress(sessionId) !== undefined,
      }),
    }, ProjectEntry))
  })
}

export default { name, inject, apply }
