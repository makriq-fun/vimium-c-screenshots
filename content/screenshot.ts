/**
 * Keyboard-only screenshots for Vimium C Screenshots.
 *
 * `ss` shows Vimium-style hints for meaningful elements; after a hint is chosen the element is
 * highlighted and `s` captures it. `sa`/`sv` capture the whole page or the visible viewport at once.
 * This module only measures and scrolls; the background page captures and copies the PNG.
 */
import { clearTimeout_, fgCache, isTop, OnFirefox, timeout_ } from "../lib/utils"
import {
  getMappedKey, isEscape_, isRepeated_, keybody_, removeHandler_, replaceOrSuppressMost_
} from "../lib/keyboard_utils"
import { hudHide, hudShow, hudTip } from "./hud"
import { GetParent_unsafe_, htmlTag_ } from "../lib/dom_utils"

type ShotMode = ScreenshotNS.Mode
type ShotRect = ScreenshotNS.Rect

interface LabelEntry {
  el: Element
  label: string
  marker: HTMLElement
}

interface SavedVisibility {
  el: HTMLElement
  value: string
  priority: string
}

interface PageState {
  style: HTMLStyleElement
  scrollX: number
  scrollY: number
  fixed: SavedVisibility[]
  hidden: boolean
}

const UI_ID = "vimium-c-screenshot-ui"
const TEST_HOOK = location.search.indexOf("vcs-test=1") >= 0

const setTestState = (text: string): void => {
  if (TEST_HOOK && document.documentElement) {
    document.documentElement.setAttribute("data-vcs-state", text)
  }
}

interface FfContentRuntime {
  onMessage: { addListener(cb: (msg: ScreenshotNS.Message)
      => Promise<ScreenshotNS.Message | void> | void): void }
  sendMessage(msg: ScreenshotNS.Message): Promise<ScreenshotNS.Message | null>
}
const ffContentRuntime = OnFirefox ? (browser as typeof chrome).runtime as unknown as FfContentRuntime : null

/** limits the number of hint labels on pages with thousands of blocks */
const MAX_LABELS = 1200

const CAPTURE_STYLE = `
html, body { scrollbar-width: none !important; }
html::-webkit-scrollbar, body::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
html { scroll-behavior: auto !important; overflow-anchor: none !important; }
*, *::before, *::after {
  animation-play-state: paused !important;
  transition-property: none !important;
  caret-color: transparent !important;
}
`

const UI_CSS = `
:host { all: initial; }
.box { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
  font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.marker { position: absolute; display: inline-block; padding: 2px 4px; border: 1px solid #b58900;
  border-radius: 3px; background: #fffbe6; color: #000; white-space: nowrap;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .35); font-weight: 600; }
.marker .p { font-size: 9px; font-weight: 500; opacity: .8; margin-right: 1px; }
.hl { position: absolute; inset: 0; }
.panel { position: absolute; background: rgba(0, 0, 0, .45); }
.outline { position: absolute; box-sizing: border-box; border: 2px solid #00a8ff;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .85) inset, 0 0 12px rgba(0, 168, 255, .65); }
.tip { position: absolute; padding: 4px 8px; border-radius: 4px; background: rgba(20, 20, 20, .88);
  color: #fff; font: 500 12px/1.3 system-ui, sans-serif; white-space: nowrap; }
`

let mode: 0 | 1 | 2 = 0 // 0=idle, 1=hints shown, 2=element selected
let host: HTMLDivElement | null = null
let hostRoot: ShadowRoot | null = null
let labelBox: HTMLElement | null = null
let highlight: HTMLElement | null = null
let highlightParts: HTMLElement[] | null = null
let entries: LabelEntry[] = []
let typed = ""
let selectedEl: Element | null = null
let captureTarget: Element | null = null
let pageState: PageState | null = null
let captureBusy = false
let captureAborted = false

const delay = (ms: number): Promise<void> => new Promise<void>(resolve => {
  timeout_((): void => { resolve() }, ms)
})

const nextFrame = (): Promise<void> => new Promise<void>(resolve => {
  const fallback = timeout_((): void => { resolve() }, 250)
  requestAnimationFrame((): void => {
    clearTimeout_(fallback)
    resolve()
  })
})

const settle = async (): Promise<void> => {
  await nextFrame()
  await nextFrame()
  await delay(40)
}

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : "" + err

const hud = (text: string): void => { hudShow(kTip.raw, text) }

const removeUI = (): void => {
  window.removeEventListener("scroll", onViewportChange, true)
  window.removeEventListener("resize", onViewportChange)
  if (host && host.parentNode) { host.parentNode.removeChild(host) }
  host = null
  hostRoot = null
  labelBox = null
  highlight = null
  highlightParts = null
  entries = []
  typed = ""
  selectedEl = null
}

const stopSelection = (hideHud: boolean): void => {
  removeHandler_(kHandler.screenshot)
  removeUI()
  mode = 0
  if (hideHud) { hudHide() }
}

const makeMarker = (entry: LabelEntry): HTMLElement => {
  const marker = document.createElement("span")
  marker.className = "marker"
  marker.setAttribute("data-vcs-label", entry.label)
  const r = entry.el.getBoundingClientRect()
  marker.setAttribute("data-vcs-rect", [r.left + window.scrollX, r.top + window.scrollY, r.width, r.height]
      .map(n => Math.round(n)).join(","))
  return marker
}

const updateMarkerText = (entry: LabelEntry): void => {
  const marker = entry.marker
  while (marker.firstChild) { marker.removeChild(marker.firstChild) }
  const label = entry.label.slice(typed.length)
  if (!label) { return }
  for (let i = 0; i < label.length - 1; i++) {
    const span = document.createElement("span")
    span.className = "p"
    span.textContent = label[i]
    marker.appendChild(span)
  }
  marker.appendChild(document.createTextNode(label[label.length - 1]))
}

const onViewportChange = (): void => {
  if (mode === 1) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i], r = entry.el.getBoundingClientRect()
      const visible = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth
      entry.marker.style.display = visible && entry.label.indexOf(typed) === 0 ? "" : "none"
      if (!visible) { continue }
      const left = Math.max(0, Math.min(window.innerWidth - 8, Math.max(0, r.left) + 2))
      const top = Math.max(0, Math.min(window.innerHeight - 8, Math.max(0, r.top) + 2))
      entry.marker.style.left = left + "px"
      entry.marker.style.top = top + "px"
    }
  } else if (mode === 2) {
    drawHighlight()
  }
}

const placeMarker = (entry: LabelEntry): void => {
  const r = entry.el.getBoundingClientRect()
  const left = Math.max(0, Math.min(window.innerWidth - 8, Math.max(0, r.left) + 2))
  const top = Math.max(0, Math.min(window.innerHeight - 8, Math.max(0, r.top) + 2))
  entry.marker.style.left = left + "px"
  entry.marker.style.top = top + "px"
  entry.marker.style.display = r.bottom > 0 && r.top < window.innerHeight && r.right > 0
      && r.left < window.innerWidth ? "" : "none"
  updateMarkerText(entry)
}

const ensureRoot = (): ShadowRoot | null => {
  if (hostRoot) { return hostRoot }
  if (!document.documentElement) { return null }
  host = document.createElement("div")
  host.id = UI_ID
  host.setAttribute("aria-hidden", "true")
  host.style.setProperty("position", "fixed", "important")
  host.style.setProperty("left", "0", "important")
  host.style.setProperty("top", "0", "important")
  host.style.setProperty("width", "0", "important")
  host.style.setProperty("height", "0", "important")
  host.style.setProperty("z-index", "2147483647", "important")
  host.style.setProperty("pointer-events", "none", "important")
  host.style.setProperty("display", "block", "important")
  const root = host.attachShadow!({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = UI_CSS
  root.appendChild(style)
  const box = document.createElement("div")
  box.className = "box"
  root.appendChild(box)
  const parent = document.fullscreenElement || document.documentElement
  if (!parent) { return null }
  parent.appendChild(host)
  hostRoot = root
  labelBox = box
  return root
}

const drawHighlight = (): void => {
  if (!selectedEl || !highlight || !highlightParts) { return }
  const r = selectedEl.getBoundingClientRect()
  const left = Math.max(0, Math.min(window.innerWidth, r.left))
  const top = Math.max(0, Math.min(window.innerHeight, r.top))
  const right = Math.max(0, Math.min(window.innerWidth, r.right))
  const bottom = Math.max(0, Math.min(window.innerHeight, r.bottom))
  const w = Math.max(0, right - left), h = Math.max(0, bottom - top)
  const panelTop = highlightParts[0], panelBottom = highlightParts[1]
  const panelLeft = highlightParts[2], panelRight = highlightParts[3]
  const outline = highlightParts[4], tip = highlightParts[5]
  panelTop.style.left = "0"; panelTop.style.top = "0"
  panelTop.style.width = "100%"; panelTop.style.height = top + "px"
  panelBottom.style.left = "0"; panelBottom.style.top = bottom + "px"
  panelBottom.style.width = "100%"; panelBottom.style.bottom = "0"
  panelLeft.style.left = "0"; panelLeft.style.top = top + "px"
  panelLeft.style.width = left + "px"; panelLeft.style.height = h + "px"
  panelRight.style.left = right + "px"; panelRight.style.top = top + "px"
  panelRight.style.right = "0"; panelRight.style.height = h + "px"
  outline.style.left = left + "px"; outline.style.top = top + "px"
  outline.style.width = w + "px"; outline.style.height = h + "px"
  tip.style.left = Math.max(4, Math.min(window.innerWidth - 180, left)) + "px"
  tip.style.top = (bottom + 8 + 24 < window.innerHeight ? bottom + 8 : Math.max(4, top - 32)) + "px"
}

const showHighlight = (): void => {
  if (!hostRoot) { return }
  const box = labelBox
  if (!box) { return }
  while (box.firstChild) { box.removeChild(box.firstChild) }
  const hl = document.createElement("div")
  hl.className = "hl"
  const parts: HTMLElement[] = []
  for (const cls of ["panel", "panel", "panel", "panel", "outline"]) {
    const el = document.createElement("div")
    el.className = cls
    hl.appendChild(el)
    parts.push(el)
  }
  const tip = document.createElement("div")
  tip.className = "tip"
  tip.textContent = "s — copy · Esc — cancel"
  hl.appendChild(tip)
  parts.push(tip)
  box.appendChild(hl)
  highlight = hl
  highlightParts = parts
  drawHighlight()
}

const markerKey = (el: Element): string => {
  const r = el.getBoundingClientRect()
  return [r.left, r.top, r.width, r.height].map(n => Math.round(n)).join(",")
}

const hasSurface = (style: CSSStyleDeclaration): boolean =>
  style.backgroundImage !== "none" || style.boxShadow !== "none"
  || style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent"
  || parseFloat(style.borderTopWidth) + parseFloat(style.borderRightWidth)
    + parseFloat(style.borderBottomWidth) + parseFloat(style.borderLeftWidth) > 0

const collectCandidates = (): Element[] => {
  if (!document.body) { return [] }
  const selector = "a[href],button,input,select,textarea,summary,details,label,[role],[tabindex],[onclick],"
      + "[contenteditable],img,svg,video,audio,canvas,picture,iframe,object,embed,table,"
      + "p,pre,blockquote,figure,figcaption,ol,ul,dl,li,dt,dd,h1,h2,h3,h4,h5,h6,"
      + "article,section,aside,main,header,footer,nav,form,div,span,td,th"
  const nodes = document.body.querySelectorAll(selector)
  const out: Element[] = []
  const seen: { [rect: string]: 1 } = Object.create(null)
  const vw = window.innerWidth, vh = window.innerHeight
  for (let i = 0; i < nodes.length && out.length < MAX_LABELS * 3; i++) {
    const el = nodes[i]
    if (el.id === UI_ID) { continue }
    const tag: string = htmlTag_(el)
    if (tag === "script" || tag === "style" || tag === "template" || tag === "noscript") { continue }
    const inputEl = el as HTMLInputElement // a named cast: `tag` is "input" only after this check
    if (tag === "input" && inputEl.type === "hidden") { continue }
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) { continue }
    const style = window.getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
        || parseFloat(style.opacity || "1") < 0.05) { continue }
    const role = (el.getAttribute("role") || "").toLowerCase()
    const interactive = tag === "a" && el.hasAttribute("href") || tag === "button" || tag === "input"
        || tag === "select" || tag === "textarea" || tag === "summary" || tag === "label"
        || role === "button" || role === "link" || role === "tab" || role === "menuitem"
        || role === "checkbox" || role === "radio" || el.hasAttribute("tabindex")
    const media = tag === "img" || tag === "svg" || tag === "video" || tag === "audio"
        || tag === "canvas" || tag === "picture" || tag === "iframe" || tag === "object" || tag === "embed"
    const textBlock = tag === "p" || tag === "pre" || tag === "blockquote" || tag === "figcaption"
        || tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6"
        || tag === "ol" || tag === "ul" || tag === "dl" || tag === "li" || tag === "dt" || tag === "dd"
        || tag === "td" || tag === "th" || tag === "table"
    const generic = tag === "div" || tag === "span" || tag === "article" || tag === "section"
        || tag === "aside" || tag === "main" || tag === "header" || tag === "footer" || tag === "nav"
        || tag === "form" || tag === "figure"
    const text = (el.textContent || "").trim()
    const area = r.width * r.height
    if (generic && !interactive && !media) {
      const surface = hasSurface(style)
      if (!surface && !(text && el.children.length === 0 && area >= 200)) { continue }
      if (area > vw * vh * 0.85 && !style.boxShadow && parseFloat(style.borderTopWidth) === 0) { continue }
    }
    if (textBlock && !text && !media) { continue }
    if (!interactive && !media && !textBlock && !text) { continue }
    const key = markerKey(el)
    if (seen[key]) { continue }
    seen[key] = 1
    out.push(el)
    if (out.length >= MAX_LABELS) { break }
  }
  return out
}

const makeLabels = (candidates: Element[]): LabelEntry[] => {
  const configured = fgCache && fgCache.c || "sadjklewcmpgh"
  const chars = configured.split("").filter((ch, index, arr) => ch.length === 1 && arr.indexOf(ch) === index)
  if (chars.length < 2) { return [] }
  let len = 1
  while (len < 4 && Math.pow(chars.length, len) < candidates.length) { len++ }
  const out: LabelEntry[] = []
  for (let i = 0; i < candidates.length; i++) {
    let n = i, label = ""
    for (let j = 0; j < len; j++) {
      label = chars[n % chars.length] + label
      n = Math.floor(n / chars.length)
    }
    const entry: LabelEntry = { el: candidates[i], label, marker: null as never }
    entry.marker = makeMarker(entry)
    out.push(entry)
  }
  return out
}

const updateMarkers = (): void => {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const visible = entry.label.indexOf(typed) === 0
    entry.marker.style.display = visible ? "" : "none"
    if (!visible) { continue }
    updateMarkerText(entry)
    const r = entry.el.getBoundingClientRect()
    if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) {
      entry.marker.style.display = "none"
      continue
    }
    entry.marker.style.left = Math.max(0, Math.min(window.innerWidth - 8, Math.max(0, r.left) + 2)) + "px"
    entry.marker.style.top = Math.max(0, Math.min(window.innerHeight - 8, Math.max(0, r.top) + 2)) + "px"
  }
}

const selectElement = (entry: LabelEntry): void => {
  while (labelBox && labelBox.firstChild) { labelBox.removeChild(labelBox.firstChild) }
  entries = []
  typed = ""
  selectedEl = entry.el
  mode = 2
  showHighlight()
  hud("Screenshot: press s to copy this element (Esc to cancel)")
}

const onSelectionKey = (event: HandlerNS.Event): HandlerResult => {
  const key = getMappedKey(event, kModeId.Link)
  if (isEscape_(key)) {
    stopSelection(true)
    return HandlerResult.Prevent
  }
  if (isRepeated_(event)) { return HandlerResult.Prevent }
  if (!key || key.length !== 1 || key !== keybody_(key)) { return HandlerResult.Prevent }
  if (mode === 1) {
    typed += key
    let exact: LabelEntry | null = null, prefix = false
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.label === typed) { exact = entry; break }
      if (entry.label.indexOf(typed) === 0) { prefix = true }
    }
    if (exact) { selectElement(exact); return HandlerResult.Prevent }
    if (prefix) { updateMarkers(); return HandlerResult.Prevent }
    typed = ""
    updateMarkers()
    return HandlerResult.Prevent
  }
  if (mode === 2 && key === "s") { void beginElementCapture() }
  return HandlerResult.Prevent
}

const startSelection = (): void => {
  if (mode) { return }
  const root = ensureRoot()
  if (!root || !labelBox) { return }
  const candidates = collectCandidates()
  if (!candidates.length) {
    removeUI()
    hudTip(kTip.raw, 2, "No elements found to capture on this page")
    return
  }
  entries = makeLabels(candidates)
  if (!entries.length) {
    removeUI()
    hudTip(kTip.raw, 2, "No usable hint characters are configured")
    return
  }
  for (let i = 0; i < entries.length; i++) {
    labelBox.appendChild(entries[i].marker)
    placeMarker(entries[i])
  }
  mode = 1
  window.addEventListener("scroll", onViewportChange, true)
  window.addEventListener("resize", onViewportChange)
  replaceOrSuppressMost_(kHandler.screenshot, onSelectionKey)
  hud("Screenshot: type a hint label (Esc to cancel)")
}

const styleElement = (): HTMLStyleElement => {
  const style = document.createElement("style")
  style.textContent = CAPTURE_STYLE
  ;(document.head || document.documentElement!).appendChild(style)
  return style
}

const collectFixed = (except: Element | null): SavedVisibility[] => {
  const out: SavedVisibility[] = []
  const nodes = document.body ? document.body.getElementsByTagName("*") : null
  if (!nodes) { return out }
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i] as HTMLElement // styled elements are HTMLElements in practice
    if (except && (except === el || except.contains(el) || el.contains(except))) { continue }
    const style = window.getComputedStyle(el)
    if (style.position !== "fixed" && style.position !== "sticky") { continue }
    if (style.display === "none" || style.visibility === "hidden") { continue }
    out.push({ el, value: el.style.getPropertyValue("visibility"), priority: el.style.getPropertyPriority("visibility") })
  }
  return out
}

const hideFixed = (): void => {
  if (!pageState || pageState.hidden) { return }
  for (let i = 0; i < pageState.fixed.length; i++) {
    const saved = pageState.fixed[i]
    saved.el.style.setProperty("visibility", "hidden", "important")
  }
  pageState.hidden = true
}

const restoreFixed = (state: PageState): void => {
  for (let i = 0; i < state.fixed.length; i++) {
    const saved = state.fixed[i]
    if (saved.value) {
      saved.el.style.setProperty("visibility", saved.value, saved.priority)
    } else {
      saved.el.style.removeProperty("visibility")
    }
  }
  state.hidden = false
}

const endCapture = (): void => {
  const state = pageState
  pageState = null
  captureTarget = null
  if (!state) { return }
  try {
    window.scrollTo(state.scrollX, state.scrollY)
  } catch { /* the page may have gone away */ }
  restoreFixed(state)
  if (state.style.parentNode) { state.style.parentNode.removeChild(state.style) }
}

const clippingContainer = (el: Element): string | null => {
  const r = el.getBoundingClientRect()
  for (let p = GetParent_unsafe_(el, PNType.DirectElement) as Element | null; p
      && p !== document.body && p !== document.documentElement
      ; p = GetParent_unsafe_(p, PNType.DirectElement) as Element | null) {
    const style = window.getComputedStyle(p)
    const overflow = style.overflowX + " " + style.overflowY
    if (overflow.indexOf("auto") < 0 && overflow.indexOf("scroll") < 0
        && overflow.indexOf("hidden") < 0 && overflow.indexOf("clip") < 0) { continue }
    const pr = p.getBoundingClientRect()
    const left = pr.left + p.clientLeft, top = pr.top + p.clientTop
    const right = left + p.clientWidth, bottom = top + p.clientHeight
    if (r.left < left - 1 || r.right > right + 1 || r.top < top - 1 || r.bottom > bottom + 1) {
      return htmlTag_(p)
    }
  }
  return null
}

const fixedTarget = (el: Element): boolean => {
  for (let p: Element | null = el; p && p !== document.documentElement
      ; p = GetParent_unsafe_(p, PNType.DirectElement) as Element | null) {
    const position = window.getComputedStyle(p).position
    if (position === "fixed" || position === "sticky") { return true }
  }
  return false
}

const pageMetrics = (rect?: ShotRect, fx?: true): ScreenshotNS.Metrics => {
  const doc = document.documentElement!
  const body = document.body
  const dw = Math.max(doc.scrollWidth, doc.clientWidth, body ? body.scrollWidth : 0)
  const dh = Math.max(doc.scrollHeight, doc.clientHeight, body ? body.scrollHeight : 0)
  const vw = window.innerWidth, vh = window.innerHeight
  const out: ScreenshotNS.Metrics = {
    x: window.scrollX, y: window.scrollY, vw, vh, dw, dh,
    mx: Math.max(0, dw - vw), my: Math.max(0, dh - vh),
  }
  if (rect) { out.r = rect }
  if (fx) { out.fx = true }
  return out
}

const beginCapture = async (m: ShotMode): Promise<ScreenshotNS.Message> => {
  if (!isTop) { return { vc: "vcs", t: "begin", ok: false, e: "Screenshots are available only in the top document" } }
  hudHide()
  if (m === "viewport") {
    await settle()
    return { vc: "vcs", t: "begin", ok: true, s: pageMetrics() }
  }
  if (pageState) { return { vc: "vcs", t: "begin", ok: false, e: "A screenshot is already in progress" } }
  const style = styleElement()
  const state: PageState = { style, scrollX: window.scrollX, scrollY: window.scrollY, fixed: [], hidden: false }
  pageState = state
  try {
    await settle()
    if (m === "element") {
      const el = captureTarget
      if (!el || !el.isConnected) {
        throw new Error("The selected element is no longer on the page")
      }
      const clipped = clippingContainer(el)
      if (clipped) {
        throw new Error("The element is clipped by a scrollable <" + clipped + "> container and cannot be "
            + "captured completely")
      }
      const r = el.getBoundingClientRect()
      const fx = fixedTarget(el)
      if (fx && (r.left < -1 || r.top < -1 || r.right > window.innerWidth + 1
          || r.bottom > window.innerHeight + 1)) {
        throw new Error("This fixed/sticky element is not fully visible and cannot be captured completely")
      }
      const rect: ShotRect = {
        x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height,
      }
      if (!fx) {
        const page = pageMetrics()
        if (rect.x < -1 || rect.y < -1 || rect.x + rect.w > page.dw + 1 || rect.y + rect.h > page.dh + 1) {
          throw new Error("The element is outside the scrollable document area")
        }
      }
      state.fixed = collectFixed(el)
      return { vc: "vcs", t: "begin", ok: true, s: pageMetrics(rect, fx || undefined) }
    }
    state.fixed = collectFixed(null)
    return { vc: "vcs", t: "begin", ok: true, s: pageMetrics() }
  } catch (err) {
    endCapture()
    return { vc: "vcs", t: "begin", ok: false, e: errorText(err) }
  }
}

const prepareTile = async (msg: ScreenshotNS.Message): Promise<ScreenshotNS.Message> => {
  if (!pageState || !isTop) { return { vc: "vcs", t: "tile", ok: false, e: "No screenshot is in progress" } }
  try {
    if (msg.hf) { hideFixed() }
    const x = typeof msg.x === "number" ? msg.x : 0, y = typeof msg.y === "number" ? msg.y : 0
    window.scrollTo(x, y)
    await settle()
    return { vc: "vcs", t: "tile", ok: true, s: pageMetrics() }
  } catch (err) {
    return { vc: "vcs", t: "tile", ok: false, e: errorText(err) }
  }
}

const onCaptureKey = (event: HandlerNS.Event): HandlerResult => {
  const key = getMappedKey(event, kModeId.Link)
  if (isEscape_(key) && !captureAborted) {
    captureAborted = true
    void sendToBackground({ vc: "vcs", t: "abort" } as ScreenshotNS.Message)
    hudTip(kTip.raw, 2, "Cancelling the screenshot...")
  }
  return HandlerResult.Prevent
}

const sendToBackground = (msg: ScreenshotNS.Message): Promise<ScreenshotNS.Message | null> => {
  if (ffContentRuntime) {
    try {
      return ffContentRuntime.sendMessage(msg).then(res => res || null, () => null)
    } catch {
      return Promise.resolve(null)
    }
  }
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, (res: ScreenshotNS.Message) => { resolve(res || null) })
    } catch { resolve(null) }
  })
}

const requestCapture = (m: ShotMode): Promise<ScreenshotNS.Message | null> => new Promise(resolve => {
  let finished = false
  const finish = (result: ScreenshotNS.Message | null): void => {
    if (finished) { return }
    finished = true
    clearTimeout(timer)
    resolve(result)
  }
  const timer = setTimeout((): void => { finish(null) }, 120_000)
  void sendToBackground({ vc: "vcs", t: "capture", m } as ScreenshotNS.Message).then(finish)
})

const finishCapture = (result: ScreenshotNS.Message | null): void => {
  const aborted = captureAborted || !!result && result.e === "Screenshot cancelled"
  setTestState(!result ? "no-response" : result.ok ? "ok:" + result.w + "x" + result.h : "error:" + (result.e || ""))
  captureBusy = false
  captureAborted = false
  captureTarget = null
  removeHandler_(kHandler.screenshot)
  if (!result) {
    hudTip(kTip.raw, 2, "Screenshot failed: the extension did not respond")
  } else if (result.ok) {
    hudTip(kTip.raw, 2, "Screenshot copied to the clipboard ("
        + (result.w || 0) + "×" + (result.h || 0) + " px)")
  } else if (aborted) {
    hudTip(kTip.raw, 2, "Screenshot cancelled")
  } else {
    console.warn("[vimium-c-screenshots] capture failed:", result.e || "unknown error")
    hudTip(kTip.raw, 2, "Screenshot failed: " + (result.e || "unknown error"))
  }
}

const beginElementCapture = async (): Promise<void> => {
  const el = selectedEl
  if (!el || captureBusy) { return }
  removeUI()
  mode = 0
  captureTarget = el
  captureBusy = true
  captureAborted = false
  setTestState("capturing:element")
  hudHide()
  replaceOrSuppressMost_(kHandler.screenshot, onCaptureKey)
  const result = await requestCapture("element")
  finishCapture(result)
}

const captureWhole = async (m: ShotMode): Promise<void> => {
  if (captureBusy) { return }
  removeHandler_(kHandler.screenshot)
  removeUI()
  mode = 0
  captureBusy = true
  captureAborted = false
  setTestState("capturing:" + m)
  hudHide()
  replaceOrSuppressMost_(kHandler.screenshot, onCaptureKey)
  const result = await requestCapture(m)
  finishCapture(result)
}

export const activate = (options: CmdOptions[kFgCmd.screenshot]): void => {
  if (!isTop) {
    hudTip(kTip.raw, 2, "Screenshots are available only in the top document")
    return
  }
  if (captureBusy) { return }
  if (options.m === "element") {
    startSelection()
  } else {
    void captureWhole(options.m)
  }
}

const onExtensionMessage = (msg: ScreenshotNS.Message): Promise<ScreenshotNS.Message | void> | void => {
  if (!msg || msg.vc !== "vcs") { return }
  if (msg.t === "begin") {
    return beginCapture(msg.m || "full").then(res => res, err => {
      return { vc: "vcs", t: "begin", ok: false, e: errorText(err) } as ScreenshotNS.Message
    })
  }
  if (msg.t === "tile") {
    return prepareTile(msg).then(res => res, err => {
      return { vc: "vcs", t: "tile", ok: false, e: errorText(err) } as ScreenshotNS.Message
    })
  }
  if (msg.t === "end") {
    endCapture()
    return Promise.resolve({ vc: "vcs", t: "end", ok: true } as ScreenshotNS.Message)
  }
}

if (ffContentRuntime) {
  ffContentRuntime.onMessage.addListener(onExtensionMessage)
} else {
  chrome.runtime.onMessage.addListener((
        msg: ScreenshotNS.Message, _sender: chrome.runtime.MessageSender
        , sendResponse: (res: ScreenshotNS.Message) => void): boolean | void => {
    const pending = onExtensionMessage(msg)
    if (!pending) { return }
    pending.then(res => { res && sendResponse(res) }, () => {})
    return true
  })
}
