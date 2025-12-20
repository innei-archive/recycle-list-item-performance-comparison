import * as React from 'react'
import {
  useVirtualizer,
  type VirtualItem,
  type Virtualizer,
} from '@tanstack/react-virtual'

// -----------------------------
// Demo Data
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

// -----------------------------
// External state store (keyed by itemId)
// -----------------------------
type ItemState = { expanded: boolean }
const DEFAULT_ITEM_STATE: ItemState = { expanded: false }

function createItemStore() {
  const map = new Map<string, ItemState>()
  const listeners = new Set<() => void>()

  const get = (id: string): ItemState => map.get(id) ?? DEFAULT_ITEM_STATE

  const set = (id: string, next: ItemState) => {
    map.set(id, next)
    listeners.forEach((l) => l())
  }

  const update = (id: string, fn: (prev: ItemState) => ItemState) => {
    set(id, fn(get(id)))
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { get, set, update, subscribe }
}

const itemStore = createItemStore()

function useItemState(itemId: string | null, enabled: boolean) {
  const id = itemId ?? ''

  const subscribe = React.useCallback(
    (cb: () => void) =>
      enabled && itemId ? itemStore.subscribe(cb) : () => {},
    [enabled, itemId],
  )

  const state = React.useSyncExternalStore(
    subscribe,
    () => (enabled && itemId ? itemStore.get(id) : DEFAULT_ITEM_STATE),
    () => (enabled && itemId ? itemStore.get(id) : DEFAULT_ITEM_STATE),
  )

  const toggle = React.useCallback(() => {
    if (!enabled || !itemId) return
    itemStore.update(id, (prev) => ({ ...prev, expanded: !prev.expanded }))
  }, [enabled, itemId, id])

  return { state, toggle }
}

// -----------------------------
// Rich text parsing + cache (keyed by itemId)
// -----------------------------
const richTextCache = new Map<string, string>()

function parseRichText(markdown: string) {
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

function getRichHtml(itemId: string, markdown: string) {
  const cached = richTextCache.get(itemId)
  if (cached) return cached
  const html = parseRichText(markdown)
  richTextCache.set(itemId, html)
  return html
}

// -----------------------------
// Dynamic pool size (scrollEl-driven) + ramp-up
// - initial poolSize = 0 (避免首帧挂一堆富文本)
// - ResizeObserver 动态计算 target
// - rAF 渐进扩容到 target（每帧 +batch）
// -----------------------------
function useDynamicPoolSize(opts: {
  scrollEl: HTMLElement | null
  estimateSize: number
  overscan: number
  batch?: number
}) {
  const { scrollEl, estimateSize, overscan, batch = 8 } = opts
  const [target, setTarget] = React.useState(0)
  const [poolSize, setPoolSize] = React.useState(0)

  React.useLayoutEffect(() => {
    if (!scrollEl) return

    const compute = () => {
      const h = scrollEl.clientHeight || 0
      const nextTarget = Math.max(
        0,
        Math.ceil(h / estimateSize) + overscan * 2 + 2,
      )
      setTarget(nextTarget)
    }

    compute()

    const ro = new ResizeObserver(() => compute())
    ro.observe(scrollEl)
    return () => ro.disconnect()
  }, [scrollEl, estimateSize, overscan])

  // ✅ 只在 poolSize < target 时跑 rAF，避免长期 churn
  React.useEffect(() => {
    if (poolSize >= target) return

    let raf = 0
    const step = () => {
      setPoolSize((prev) => {
        const next = Math.min(target, prev + batch)
        return next
      })

      raf = requestAnimationFrame(step)
    }

    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [poolSize, target, batch])

  // ✅ target 减小：为了避免频繁卸载（富文本），这里做“轻微滞后”
  React.useEffect(() => {
    if (poolSize > target + batch * 4) {
      setPoolSize(target)
    }
  }, [poolSize, target, batch])

  return { poolSize, target }
}

// -----------------------------
// Slot assignments (FIXED)
// - 不再用 useEffect 初始化 freeSlots（会被 rAF render 饿死）
// - reset + reconcile 全部放在同一个 useLayoutEffect 里同步完成
// -----------------------------
function useSlotAssignments(virtualItems: VirtualItem[], poolSize: number) {
  const indexToSlot = React.useRef(new Map<number, number>())
  const slotToIndexRef = React.useRef<(number | null)[]>([])
  const freeSlots = React.useRef<number[]>([])

  // 强制刷新，让 hook 返回值更新
  const [, force] = React.useReducer((x) => x + 1, 0)

  React.useLayoutEffect(() => {
    if (poolSize <= 0) {
      indexToSlot.current.clear()
      slotToIndexRef.current = []
      freeSlots.current = []
      force()
      return
    }

    // ✅ poolSize 变化时同步 reset
    if (slotToIndexRef.current.length !== poolSize) {
      indexToSlot.current.clear()
      slotToIndexRef.current = Array.from({ length: poolSize }, () => null)
      freeSlots.current = Array.from(
        { length: poolSize },
        (_, i) => i,
      ).reverse()
    }

    const visible = new Set(virtualItems.map((v) => v.index))

    // release
    for (const [idx, slot] of indexToSlot.current) {
      if (!visible.has(idx)) {
        indexToSlot.current.delete(idx)
        slotToIndexRef.current[slot] = null
        freeSlots.current.push(slot)
      }
    }

    // assign
    for (const v of virtualItems) {
      if (!indexToSlot.current.has(v.index)) {
        const slot = freeSlots.current.pop()
        if (slot == null) continue
        indexToSlot.current.set(v.index, slot)
        slotToIndexRef.current[slot] = v.index
      }
    }

    force()
  }, [virtualItems, poolSize])

  return slotToIndexRef.current
}

// -----------------------------
// RowContent: always mounted per slot, but inactive is very cheap
// - heavy rich-text only when active
// - parsed result cached by itemId
// -----------------------------
const DynamicHeight = React.memo(function DynamicHeight() {
  const [height] = React.useState(() => Math.random() * 100)
  return <div style={{ height: `${height}px` }}>Dynamic Height</div>
})

const RowContent = React.memo(function RowContent(props: {
  active: boolean
  item: Item | null
}) {
  const { active, item } = props
  const itemId = item?.id ?? null

  const { state, toggle } = useItemState(itemId, active)

  const html = React.useMemo(() => {
    if (!active || !item) return ''
    return getRichHtml(item.id, item.markdown)
  }, [active, item])

  if (!active || !item) return <div />

  return (
    <div style={{ padding: 12, borderBottom: '1px solid #2f2f2f' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontWeight: 700 }}>{item.title}</div>
        <button
          onClick={toggle}
          style={{
            padding: '4px 8px',
            borderRadius: 8,
            border: '1px solid #444',
            background: 'transparent',
            color: '#ddd',
            cursor: 'pointer',
          }}
        >
          {state.expanded ? 'Collapse' : 'Expand'}
        </button>
        <span style={{ opacity: 0.6, fontSize: 12 }}>{item.id}</span>
      </div>

      <div
        style={{
          marginTop: 8,
          opacity: 0.92,
          maxHeight: state.expanded ? 9999 : 96,
          overflow: 'hidden',
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <DynamicHeight />
    </div>
  )
})

// -----------------------------
// SlotRow: fixed slot component (key=slotId in parent)
// - 动态高度：不要写死 height=vItem.size（会把内容夹爆），只用 minHeight 兜底
// -----------------------------
const SlotRow = React.memo(function SlotRow(props: {
  slotId: number
  index: number | null
  vItem?: VirtualItem
  item: Item | null
  virtualizer: Virtualizer<HTMLDivElement, Element>
}) {
  const { slotId, index, vItem, item, virtualizer } = props
  const instanceIdRef = React.useRef(Math.random().toString(16).slice(2, 8))
  const active = index != null && vItem != null && item != null

  return (
    <div
      data-index={index ?? -1}
      ref={active ? virtualizer.measureElement : undefined}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${
          active ? vItem!.start - virtualizer.options.scrollMargin : -999999
        }px)`,
        visibility: active ? 'visible' : 'hidden',
        pointerEvents: active ? 'auto' : 'none',
        boxSizing: 'border-box',
        minHeight: active ? vItem!.size : 0,
        willChange: 'transform',
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.55, padding: '6px 12px 0' }}>
        slot #{slotId} / instance {instanceIdRef.current} / index {index ?? '∅'}
      </div>
      <RowContent active={active} item={item} />
    </div>
  )
})

// -----------------------------
// App
// -----------------------------
export default function App() {
  const data = React.useMemo(() => makeData(20000), [])

  // ✅ 用 state 保存 scrollEl，避免首帧 getScrollElement 为 null 的空窗期（TanStack issue 里有人踩过） :contentReference[oaicite:4]{index=4}
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null)
  const setScrollRef = React.useCallback(
    (node: HTMLDivElement | null) => setScrollEl(node),
    [],
  )

  const estimate = 92
  const overscan = 8

  const { poolSize, target } = useDynamicPoolSize({
    scrollEl,
    estimateSize: estimate,
    overscan,
    batch: 8,
  })

  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => estimate,
    overscan,
    initialOffset: 0,
    initialRect: { height: 560, width: 0 },
  })

  // ✅ scrollEl ready 后主动 measure 一次，保证首屏就能算出 items
  React.useLayoutEffect(() => {
    if (!scrollEl) return
    virtualizer.measure()
  }, [scrollEl, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()
  const slotToIndex = useSlotAssignments(virtualItems, poolSize)

  const vItemByIndex = React.useMemo(() => {
    const m = new Map<number, VirtualItem>()
    for (const v of virtualItems) m.set(v.index, v)
    return m
  }, [virtualItems])

  // debug：你现在应该能看到 assigned > 0
  const assigned = slotToIndex.reduce<number>(
    (n, x) => n + (x == null ? 0 : 1),
    0,
  )

  return (
    <div
      style={{
        padding: 16,
        fontFamily: 'ui-sans-serif, system-ui',
        color: '#ddd',
        background: '#111',
        minHeight: '100vh',
      }}
    >
      <h2 style={{ margin: 0 }}>
        TanStack Virtual + Slot Pool (RichText Optimized)
      </h2>
      <div style={{ marginTop: 8, opacity: 0.75, fontSize: 13 }}>
        poolSize: {poolSize} / target: {target} / virtualItems:{' '}
        {virtualItems.length} / assigned: {assigned}
      </div>

      <div
        ref={setScrollRef}
        style={{
          height: 560,
          overflow: 'auto',
          border: '1px solid #333',
          borderRadius: 12,
          marginTop: 12,
          background: '#151515',
        }}
      >
        <div
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
        >
          {Array.from({ length: poolSize }, (_, slotId) => {
            const index = slotToIndex[slotId] ?? null
            const vItem = index != null ? vItemByIndex.get(index) : undefined
            const item = index != null ? data[index] : null
            return (
              <SlotRow
                key={slotId}
                slotId={slotId}
                index={index}
                vItem={vItem}
                item={item}
                virtualizer={virtualizer}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
