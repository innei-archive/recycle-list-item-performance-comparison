import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import RecycleSlotPoolDemo from './App'

type Mode = 'recycle' | 'window'

type ProfilerSample = {
  phase: 'mount' | 'update' | 'nested-update'
  actualDuration: number
  baseDuration: number
  startTime: number
  commitTime: number
}

type Summary = {
  count: number
  avgActualMs: number
  p95ActualMs: number
  maxActualMs: number
}

function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const next = sorted[base + 1]
  if (next == null) return sorted[base] ?? 0
  return (sorted[base] ?? 0) + rest * (next - (sorted[base] ?? 0))
}

function summarize(samples: ProfilerSample[]): Summary {
  const actual = samples.map((s) => s.actualDuration).sort((a, b) => a - b)
  const sum = actual.reduce((a, b) => a + b, 0)
  const avg = actual.length ? sum / actual.length : 0
  const p95 = quantile(actual, 0.95)
  const max = actual.length ? actual[actual.length - 1]! : 0
  return {
    count: actual.length,
    avgActualMs: avg,
    p95ActualMs: p95,
    maxActualMs: max,
  }
}

function useProfilerBuffer(capacity = 120) {
  const samplesRef = React.useRef<ProfilerSample[]>([])
  const [samples, setSamples] = React.useState<ProfilerSample[]>([])
  const lastCommitTimeRef = React.useRef(0)
  const [lastCommitTime, setLastCommitTime] = React.useState(0)
  const rafRef = React.useRef<number | null>(null)

  const scheduleBump = React.useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      // 这里才把 ref 里的快照提交到 state，用于驱动 UI 刷新
      // 注意：用 slice() 确保每次都是新引用，避免 React 认为“值相同”而跳过更新
      setSamples(samplesRef.current.slice())
      setLastCommitTime(lastCommitTimeRef.current)
    })
  }, [])

  const onRender: React.ProfilerOnRenderCallback = React.useCallback(
    (
      _id: string,
      phase,
      actualDuration: number,
      baseDuration: number,
      startTime: number,
      commitTime: number,
    ) => {
      const prev = samplesRef.current
      const next: ProfilerSample[] = [
        ...prev,
        { phase, actualDuration, baseDuration, startTime, commitTime },
      ]
      samplesRef.current =
        next.length > capacity ? next.slice(next.length - capacity) : next
      lastCommitTimeRef.current = commitTime

      // ⚠️ 不要在 Profiler callback 里直接 setState（会触发 commit -> callback -> setState 的循环）
      // 这里用 rAF 合并刷新频率（最多每帧一次）。
      scheduleBump()
    },
    [capacity, scheduleBump],
  )

  React.useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const reset = React.useCallback(() => {
    samplesRef.current = []
    setSamples([])
    lastCommitTimeRef.current = 0
    setLastCommitTime(0)
  }, [])

  return { samples, onRender, reset, lastCommitTime }
}

// -----------------------------
// Demo Data (for "window recreate" list)
// -----------------------------
type Item = {
  id: string
  title: string
  markdown: string
}

function makeMarkdown(i: number) {
  const lines = 2 + ((i * 7) % 18)
  const body = Array.from(
    { length: lines },
    (_, k) => `- line ${k + 1}: **rich text** demo ${i}`,
  ).join('\n')
  return `# Title ${i}\n\n${body}\n\n> quote ${i}\n`
}

function makeData(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item_${i}`,
    title: `Row ${i}`,
    markdown: makeMarkdown(i),
  }))
}

type CounterSnapshot = {
  parseCalls: number
  mounts: number
  unmounts: number
}

function useCounters() {
  const ref = React.useRef<CounterSnapshot>({
    parseCalls: 0,
    mounts: 0,
    unmounts: 0,
  })
  const [, force] = React.useReducer((x) => x + 1, 0)

  const inc = React.useCallback((key: keyof CounterSnapshot) => {
    ref.current[key] += 1
  }, [])

  const snapshot = React.useCallback(() => {
    force()
    return ref.current
  }, [])

  const reset = React.useCallback(() => {
    ref.current = { parseCalls: 0, mounts: 0, unmounts: 0 }
    force()
  }, [])

  return React.useMemo(
    () => ({ ref, inc, snapshot, reset }),
    [inc, snapshot, reset],
  )
}

function parseRichText(
  markdown: string,
  counters?: { inc: (k: 'parseCalls') => void },
) {
  counters?.inc('parseCalls')
  // 模拟“很重”的解析：替换成你真实的富文本解析即可
  let acc = 0
  for (let i = 0; i < markdown.length; i++) {
    acc = (acc + markdown.charCodeAt(i) * 33) % 1000003
  }

  const escaped = markdown
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\n', '<br/>')

  return `<div data-acc="${acc}">${escaped}</div>`
}

function createRichCache() {
  const cache = new Map<string, string>()
  return {
    get(
      itemId: string,
      markdown: string,
      counters?: { inc: (k: 'parseCalls') => void },
    ) {
      const hit = cache.get(itemId)
      if (hit) return hit
      const html = parseRichText(markdown, counters)
      cache.set(itemId, html)
      return html
    },
    clear() {
      cache.clear()
    },
  }
}

const Row = React.memo(function Row(props: {
  item: Item
  cacheEnabled: boolean
  cache: ReturnType<typeof createRichCache>
  counters: { inc: (k: 'parseCalls' | 'mounts' | 'unmounts') => void }
}) {
  const { item, cacheEnabled, cache, counters } = props
  const [expanded, setExpanded] = React.useState(false)

  React.useEffect(() => {
    counters.inc('mounts')
    return () => counters.inc('unmounts')
  }, [counters])

  const html = React.useMemo(() => {
    return cacheEnabled
      ? cache.get(item.id, item.markdown, {
          inc: () => counters.inc('parseCalls'),
        })
      : parseRichText(item.markdown, { inc: () => counters.inc('parseCalls') })
  }, [cache, cacheEnabled, item.id, item.markdown, counters])

  return (
    <div style={{ padding: 12, borderBottom: '1px solid #2f2f2f' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontWeight: 700 }}>{item.title}</div>
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            padding: '4px 8px',
            borderRadius: 8,
            border: '1px solid #444',
            background: 'transparent',
            color: '#ddd',
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
        <span style={{ opacity: 0.6, fontSize: 12 }}>{item.id}</span>
      </div>

      <div
        style={{
          marginTop: 8,
          opacity: 0.92,
          maxHeight: expanded ? 9999 : 96,
          overflow: 'hidden',
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
})

function WindowRecreateList(props: {
  height: number
  itemCount: number
  overscan: number
  estimateSize: number
  cacheEnabled: boolean
  counters: ReturnType<typeof useCounters>
}) {
  const { height, itemCount, overscan, estimateSize, cacheEnabled, counters } =
    props
  const data = React.useMemo(() => makeData(itemCount), [itemCount])
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null)

  const cache = React.useMemo(() => createRichCache(), [])
  React.useEffect(() => {
    // 切换 cacheEnabled 时不清理 cache（更贴近真实 app：cache 一般是跨滚动生命周期的）
    // 如果你想比较“完全无 cache”的最差情况，可以手动点击 Reset counters + reload
  }, [cacheEnabled])

  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => estimateSize,
    overscan,
    initialRect: { height, width: 0 },
  })

  React.useLayoutEffect(() => {
    if (!scrollEl) return
    virtualizer.measure()
  }, [scrollEl, virtualizer])

  const items = virtualizer.getVirtualItems()

  return (
    <div
      ref={setScrollEl}
      style={{
        height,
        overflow: 'auto',
        border: '1px solid #333',
        borderRadius: 12,
        marginTop: 12,
        background: '#151515',
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map((v) => {
          const item = data[v.index]!
          return (
            <div
              key={item.id}
              ref={virtualizer.measureElement}
              data-index={v.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${v.start}px)`,
                boxSizing: 'border-box',
              }}
            >
              <Row
                item={item}
                cacheEnabled={cacheEnabled}
                cache={cache}
                counters={{ inc: (k) => counters.inc(k) }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StatRow(props: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ opacity: 0.75 }}>{props.label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{props.value}</span>
    </div>
  )
}

function Badge(props: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        border: '1px solid #2f2f2f',
        background: '#161616',
        fontSize: 12,
        opacity: 0.95,
      }}
    >
      {props.children}
    </span>
  )
}

const RecyclePanel = React.memo(function RecyclePanel(props: {
  onRender: React.ProfilerOnRenderCallback
}) {
  return (
    <React.Profiler id="recycle-slot-pool" onRender={props.onRender}>
      {/* 复用你现有 app demo 的 slot pool 实现 */}
      <RecycleSlotPoolDemo />
    </React.Profiler>
  )
})

const WindowPanel = React.memo(function WindowPanel(props: {
  onRender: React.ProfilerOnRenderCallback
  height: number
  itemCount: number
  overscan: number
  estimateSize: number
  cacheEnabled: boolean
  counters: ReturnType<typeof useCounters>
}) {
  const { onRender, ...rest } = props
  return (
    <React.Profiler id="window-recreate" onRender={onRender}>
      <WindowRecreateList {...rest} />
    </React.Profiler>
  )
})

export default function BatchPerformanceComparison() {
  const [mode, setMode] = React.useState<Mode>('recycle')
  const [cacheEnabled, setCacheEnabled] = React.useState(true)
  const [height, setHeight] = React.useState(560)
  const [itemCount, setItemCount] = React.useState(20000)
  const [estimateSize, setEstimateSize] = React.useState(92)
  const [overscan, setOverscan] = React.useState(8)

  const recycleProfiler = useProfilerBuffer(120)
  const windowProfiler = useProfilerBuffer(120)
  const counters = useCounters()

  const recycleSummary = React.useMemo(
    () => summarize(recycleProfiler.samples),
    [recycleProfiler.samples],
  )
  const windowSummary = React.useMemo(
    () => summarize(windowProfiler.samples),
    [windowProfiler.samples],
  )

  const counterSnapshot = counters.ref.current

  return (
    <div
      style={{
        padding: 16,
        fontFamily: 'ui-sans-serif, system-ui',
        color: '#ddd',
        width: '100%',
        margin: '0 auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h2 style={{ margin: 0 }}>
          createElement vs update: Recycle vs Window Re-create
        </h2>
        <Badge>React 19 + TanStack Virtual</Badge>
      </div>

      <div
        style={{ marginTop: 10, opacity: 0.8, fontSize: 13, lineHeight: 1.5 }}
      >
        这个页面主要对比两类开销：
        <br />
        1) <b>Recycle (slot pool)</b>：固定 N 个 item 组件常驻，滚动时主要是{' '}
        <b>更新 props/transform</b>，重逻辑只在 active 时运行。
        <br />
        2) <b>Window re-create</b>：按当前 virtualItems 直接渲染，滚动时大量
        item <b>mount/unmount</b>，重逻辑（富文本解析）更容易重复发生，且
        component 内部 state 会丢失。
        <br />
        说明：JSX 的 <b>createElement</b> 本身通常很便宜，真正差距多数来自{' '}
        <b>commit（挂载/卸载/DOM 变更）</b> 与 <b>重计算</b>；下面用 Profiler 的{' '}
        <b>actualDuration</b>（渲染耗时）和 mount/parse 计数来观测。
      </div>

      <div
        style={{
          marginTop: 12,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          alignItems: 'center',
        }}
      >
        <button
          onClick={() => setMode('recycle')}
          style={{
            padding: '6px 10px',
            borderRadius: 10,
            border: mode === 'recycle' ? '1px solid #888' : '1px solid #333',
            background: mode === 'recycle' ? '#1b1b1b' : 'transparent',
            color: '#ddd',
            cursor: 'pointer',
          }}
        >
          Recycle (slot pool)
        </button>
        <button
          onClick={() => setMode('window')}
          style={{
            padding: '6px 10px',
            borderRadius: 10,
            border: mode === 'window' ? '1px solid #888' : '1px solid #333',
            background: mode === 'window' ? '#1b1b1b' : 'transparent',
            color: '#ddd',
            cursor: 'pointer',
          }}
        >
          Window re-create
        </button>

        <span style={{ opacity: 0.5 }}>·</span>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ opacity: 0.75, fontSize: 13 }}>height</span>
          <input
            type="number"
            value={height}
            onChange={(e) => setHeight(Number(e.target.value))}
            style={{
              width: 90,
              padding: '6px 8px',
              borderRadius: 10,
              border: '1px solid #333',
              background: '#141414',
              color: '#ddd',
            }}
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ opacity: 0.75, fontSize: 13 }}>items</span>
          <input
            type="number"
            value={itemCount}
            onChange={(e) => setItemCount(Number(e.target.value))}
            style={{
              width: 110,
              padding: '6px 8px',
              borderRadius: 10,
              border: '1px solid #333',
              background: '#141414',
              color: '#ddd',
            }}
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ opacity: 0.75, fontSize: 13 }}>estimate</span>
          <input
            type="number"
            value={estimateSize}
            onChange={(e) => setEstimateSize(Number(e.target.value))}
            style={{
              width: 90,
              padding: '6px 8px',
              borderRadius: 10,
              border: '1px solid #333',
              background: '#141414',
              color: '#ddd',
            }}
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ opacity: 0.75, fontSize: 13 }}>overscan</span>
          <input
            type="number"
            value={overscan}
            onChange={(e) => setOverscan(Number(e.target.value))}
            style={{
              width: 70,
              padding: '6px 8px',
              borderRadius: 10,
              border: '1px solid #333',
              background: '#141414',
              color: '#ddd',
            }}
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={cacheEnabled}
            onChange={(e) => setCacheEnabled(e.target.checked)}
          />
          <span style={{ opacity: 0.85, fontSize: 13 }}>
            richtext cache (window mode)
          </span>
        </label>

        <button
          onClick={() => {
            recycleProfiler.reset()
            windowProfiler.reset()
            counters.reset()
          }}
          style={{
            padding: '6px 10px',
            borderRadius: 10,
            border: '1px solid #333',
            background: 'transparent',
            color: '#ddd',
            cursor: 'pointer',
          }}
        >
          Reset stats
        </button>
      </div>

      <div
        style={{
          marginTop: 12,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 12,
        }}
      >
        <div
          style={{
            border: '1px solid #2a2a2a',
            borderRadius: 12,
            padding: 12,
            background: '#121212',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            Recycle (slot pool)
          </div>
          <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.5 }}>
            <StatRow label="Profiler samples" value={recycleSummary.count} />
            <StatRow
              label="last commitTime"
              value={
                recycleProfiler.lastCommitTime
                  ? recycleProfiler.lastCommitTime.toFixed(2)
                  : '-'
              }
            />
            <StatRow
              label="avg actualDuration"
              value={`${recycleSummary.avgActualMs.toFixed(2)} ms`}
            />
            <StatRow
              label="p95 actualDuration"
              value={`${recycleSummary.p95ActualMs.toFixed(2)} ms`}
            />
            <StatRow
              label="max actualDuration"
              value={`${recycleSummary.maxActualMs.toFixed(2)} ms`}
            />
          </div>
        </div>

        <div
          style={{
            border: '1px solid #2a2a2a',
            borderRadius: 12,
            padding: 12,
            background: '#121212',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            Window re-create
          </div>
          <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.5 }}>
            <StatRow label="Profiler samples" value={windowSummary.count} />
            <StatRow
              label="last commitTime"
              value={
                windowProfiler.lastCommitTime
                  ? windowProfiler.lastCommitTime.toFixed(2)
                  : '-'
              }
            />
            <StatRow
              label="avg actualDuration"
              value={`${windowSummary.avgActualMs.toFixed(2)} ms`}
            />
            <StatRow
              label="p95 actualDuration"
              value={`${windowSummary.p95ActualMs.toFixed(2)} ms`}
            />
            <StatRow
              label="max actualDuration"
              value={`${windowSummary.maxActualMs.toFixed(2)} ms`}
            />
            <div style={{ height: 8 }} />
            <StatRow label="Row mounts" value={counterSnapshot.mounts} />
            <StatRow label="Row unmounts" value={counterSnapshot.unmounts} />
            <StatRow
              label="parseRichText calls"
              value={counterSnapshot.parseCalls}
            />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        {mode === 'recycle' ? (
          <RecyclePanel onRender={recycleProfiler.onRender} />
        ) : (
          <WindowPanel
            onRender={windowProfiler.onRender}
            height={height}
            itemCount={itemCount}
            overscan={overscan}
            estimateSize={estimateSize}
            cacheEnabled={cacheEnabled}
            counters={counters}
          />
        )}
      </div>
    </div>
  )
}
