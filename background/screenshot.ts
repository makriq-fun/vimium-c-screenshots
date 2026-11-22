/**
 * Stitched screenshots for Vimium C Screenshots.
 *
 * The content script tells this module which part of the page to capture. This module scrolls the
 * page tile by tile, calls `tabs.captureVisibleTab`, stitches the tiles on a canvas and copies the
 * result to the clipboard. Images never leave the browser.
 */
import { browser_, Tabs_ } from "./browser"
import { handleImageUrl } from "./frame_commands"
import { calcOutputSize, planTiles, ShotRect, ShotTile } from "../lib/screenshot_geometry"
import { OnFirefox } from "../lib/utils"

/** Firefox's canvas limit is 32767x32767; keep a conservative pixel budget to avoid OOM. */
const MAX_SIDE = 32767
const MAX_PIXELS = 64_000_000
const MAX_TILES = 400
/** A content script must answer a `begin`/`tile`/`end` message within this time. */
const TAB_MESSAGE_TIMEOUT = 10_000
/** Chrome limits `captureVisibleTab` call frequency; Firefox has no such quota. */
const CAPTURE_DELAY = 620

declare function createImageBitmap(blob: Blob): Promise<ImageBitmap>

interface OffscreenContext2D {
  drawImage(image: ImageBitmap, dx: number, dy: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  imageSmoothingEnabled: boolean
}

interface OffscreenCanvasLike {
  width: number
  height: number
  getContext(id: "2d"): OffscreenContext2D | null
  convertToBlob(options?: { type: string }): Promise<Blob>
}

declare var OffscreenCanvas: { new (w: number, h: number): OffscreenCanvasLike } | undefined

interface ShotCanvas {
  ctx: OffscreenContext2D
  toBlob: () => Promise<Blob | null>
}

interface CaptureState { aborted: boolean }

const activeCaptures = new Map<number, CaptureState>()

interface FfRuntime {
  onMessage: { addListener(cb: (msg: ScreenshotNS.Message, sender: chrome.runtime.MessageSender)
      => Promise<ScreenshotNS.Message | void> | void): void }
}
const ffRuntime = OnFirefox ? browser_.runtime as unknown as FfRuntime : null
const ffSendToTab = OnFirefox ? browser_.tabs.sendMessage as unknown as
    ((tabId: number, msg: ScreenshotNS.Message, options: { frameId: number })
      => Promise<ScreenshotNS.Message | null>) : null

const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout((): void => { resolve() }, ms) })

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === "string" ? err : "" + err

const makeCanvas = (width: number, height: number): ShotCanvas | null => {
  try {
    if (typeof document !== "undefined" && document.createElement) {
      const el = document.createElement("canvas")
      el.width = width; el.height = height
      const ctx = el.getContext("2d")
      if (!ctx) { return null }
      return {
        ctx: ctx as unknown as OffscreenContext2D,
        toBlob: () => new Promise<Blob | null>(resolve => { el.toBlob(resolve, "image/png") }),
      }
    }
    if (typeof OffscreenCanvas === "function") {
      const el = new OffscreenCanvas(width, height)
      const ctx = el.getContext("2d")
      if (!ctx) { return null }
      return {
        ctx,
        toBlob: () => el.convertToBlob({ type: "image/png" }).then((blob: Blob) => blob, () => null),
      }
    }
  } catch { /* allocation failed */ }
  return null
}

const captureVisible = (windowId: number): Promise<string | null> => new Promise(resolve => {
  try {
    Tabs_.captureVisibleTab(windowId, { format: "png" }, (url: string) => {
      resolve(url || null)
    })
  } catch { resolve(null) }
})

const decodeBlob = (blob: Blob): Promise<ImageBitmap> => {
  const bitmap = createImageBitmap(blob)
  const timeout = new Promise<ImageBitmap>((_, reject) => {
    setTimeout(() => { reject(new Error("Timed out while decoding the captured image")) }, 20_000)
  })
  return Promise.race([bitmap, timeout])
}

const sendToTab = <T extends ScreenshotNS.Message>(tabId: number, msg: ScreenshotNS.Message): Promise<T | null> =>
  new Promise<T | null>(resolve => {
    let finished = false
    const finish = (value: T | null): void => {
      if (finished) { return }
      finished = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => { finish(null) }, TAB_MESSAGE_TIMEOUT)
    if (ffSendToTab) {
      ffSendToTab(tabId, msg, { frameId: 0 }).then(response => finish(response as T || null), () => { finish(null) })
      return
    }
    try {
      chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (response: T) => {
        finish(response || null)
      })
    } catch { finish(null) }
  })

const copyPngData = (data: ArrayBuffer): Promise<boolean> =>
  browser_.clipboard && browser_.clipboard.setImageData
    ? browser_.clipboard.setImageData(data, "png").then(() => true, () => false)
    : Promise.resolve(false)

const copyImageUrl = (url: string): Promise<boolean> => {
  if (OnFirefox) {
    return fetch(url as `data:${string}`).then(res => res.arrayBuffer()).then(copyPngData, () => false)
  }
  return new Promise<boolean>(resolve => {
    handleImageUrl(url as `data:${string}`, null, kTeeTask.CopyImage, (ok: BOOL | boolean) => {
      resolve(!!ok)
    }, "screenshot.png", "")
  })
}

const copyImageBlob = (blob: Blob): Promise<boolean> => {
  if (OnFirefox) {
    return blob.arrayBuffer().then(copyPngData, () => false)
  }
  return new Promise<boolean>(resolve => {
    handleImageUrl("", blob, kTeeTask.CopyImage, (ok: BOOL | boolean) => { resolve(!!ok) }, "screenshot.png", "")
  })
}

const imageSize = (url: string): Promise<{ w: number; h: number } | null> =>
  fetch(url as `data:${string}`).then(res => res.blob()).then(decodeBlob).then(bitmap => {
    const size = { w: bitmap.width, h: bitmap.height }
    bitmap.close()
    return size
  }, () => null)

const fail = (error: string): ScreenshotNS.Message => ({ vc: "vcs", t: "capture", ok: false, e: error })

const checkAborted = (state: CaptureState): void => {
  if (state.aborted) { throw new Error("Screenshot cancelled") }
}

const captureViewport = async (tabId: number, windowId: number): Promise<ScreenshotNS.Message> => {
  const begin = await sendToTab(tabId, { vc: "vcs", t: "begin", m: "viewport" })
  if (!begin || !begin.ok) { return fail(begin && begin.e || "Cannot access the page") }
  await delay(120)
  const url = await captureVisible(windowId)
  if (!url) { return fail("The browser refused to capture this tab") }
  const size = await imageSize(url)
  if (!size) { return fail("The captured image could not be decoded") }
  const copied = await copyImageUrl(url)
  return copied ? { vc: "vcs", t: "capture", ok: true, w: size.w, h: size.h }
      : fail("Failed to copy the screenshot to the clipboard")
}

const capturePage = async (tabId: number, windowId: number, mode: ScreenshotNS.Mode
    , state: CaptureState): Promise<ScreenshotNS.Message> => {
  const begin = await sendToTab(tabId, { vc: "vcs", t: "begin", m: mode })
  if (!begin || !begin.ok || !begin.s) { return fail(begin && begin.e || "Cannot access the page") }
  const page = begin.s
  const rect: ShotRect | null = mode === "element" && page.r ? page.r
      : mode === "full" ? { x: 0, y: 0, w: page.dw, h: page.dh }
      : null
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) { return fail("Nothing to capture") }
  let tiles: ShotTile[] | null
  if (page.fx) {
    if (rect.w > page.vw + 1 || rect.h > page.vh + 1) {
      return fail("This fixed element is larger than the viewport and cannot be captured completely")
    }
    tiles = [{ x: page.x, y: page.y }]
  } else {
    tiles = planTiles(rect, { w: page.vw, h: page.vh }, page.mx, page.my, MAX_TILES)
    if (!tiles) { return fail("The screenshot is too large (more than " + MAX_TILES + " tiles)") }
  }
  let canvas: ShotCanvas | null = null, scaleX = 0, scaleY = 0, outW = 0, outH = 0, first = true
  try {
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]
      checkAborted(state)
      const prepared = await sendToTab(tabId, {
        vc: "vcs", t: "tile", x: tile.x, y: tile.y, hf: mode === "element" || i > 0,
      })
      if (!prepared || !prepared.ok || !prepared.s) {
        throw new Error(prepared && prepared.e || "The page stopped responding")
      }
      checkAborted(state)
      if (i > 0 && Build.BTypes & BrowserType.Chrome) { await delay(CAPTURE_DELAY) }
      const url = await captureVisible(windowId)
      if (!url) { throw new Error("The browser refused to capture this tab") }
      const bitmap = await decodeBlob(await fetch(url as `data:${string}`).then(res => res.blob()))
      try {
        if (first) {
          scaleX = bitmap.width / prepared.s.vw
          scaleY = bitmap.height / prepared.s.vh
          const size = calcOutputSize(rect.w, rect.h, scaleX, scaleY, MAX_SIDE, MAX_PIXELS)
          if (!size) {
            throw new Error("The screenshot is too large (limit: " + MAX_SIDE + " px per side, "
                + (MAX_PIXELS / 1_000_000) + " MP)")
          }
          canvas = makeCanvas(size.w, size.h)
          if (!canvas) { throw new Error("Not enough memory to create the screenshot canvas") }
          outW = size.w; outH = size.h
          first = false
        } else if (Math.abs(bitmap.width - Math.round(prepared.s.vw * scaleX)) > 1
            || Math.abs(bitmap.height - Math.round(prepared.s.vh * scaleY)) > 1) {
          throw new Error("The page zoom changed while capturing")
        }
        if (!canvas) { throw new Error("The screenshot canvas is missing") }
        canvas.ctx.drawImage(bitmap, (prepared.s.x - rect.x) * scaleX, (prepared.s.y - rect.y) * scaleY)
      } finally {
        bitmap.close()
      }
    }
    if (!canvas) { throw new Error("The screenshot is empty") }
    const blob = await canvas.toBlob()
    if (!blob) { throw new Error("The screenshot could not be encoded as PNG") }
    const copied = await copyImageBlob(blob)
    if (!copied) { throw new Error("Failed to copy the screenshot to the clipboard") }
    return { vc: "vcs", t: "capture", ok: true, w: outW, h: outH }
  } catch (err) {
    return fail(errorText(err))
  } finally {
    await sendToTab(tabId, { vc: "vcs", t: "end" })
  }
}

const runCapture = async (tab: chrome.tabs.Tab, msg: ScreenshotNS.Message
    , state: CaptureState): Promise<ScreenshotNS.Message> => {
  const tabId = tab.id!
  const windowId = typeof tab.windowId === "number" ? tab.windowId : browser_.windows.WINDOW_ID_CURRENT
  if (tabId < 0) { return fail("This tab cannot be captured") }
  if (msg.m === "viewport") { return captureViewport(tabId, windowId) }
  return capturePage(tabId, windowId, msg.m || "full", state)
}

const onMessage = (msg: ScreenshotNS.Message, sender: chrome.runtime.MessageSender):
    Promise<ScreenshotNS.Message | void> | void => {
  if (!msg || msg.vc !== "vcs") { return }
  const tab = sender.tab
  if (msg.t === "abort") {
    const active = tab && tab.id != null ? activeCaptures.get(tab.id) : null
    if (active) { active.aborted = true }
    return
  }
  if (msg.t !== "capture" || !tab || tab.id == null) { return }
  if (sender.frameId != null && sender.frameId !== 0) {
    return Promise.resolve(fail("Screenshots are available only in the top frame"))
  }
  const state: CaptureState = { aborted: false }
  activeCaptures.set(tab.id, state)
  return runCapture(tab, msg, state).then(result => {
    activeCaptures.delete(tab.id!)
    return result
  }, err => {
    activeCaptures.delete(tab.id!)
    return fail(errorText(err))
  })
}

if (ffRuntime) {
  ffRuntime.onMessage.addListener(onMessage)
} else {
  chrome.runtime.onMessage.addListener((msg: ScreenshotNS.Message, sender: chrome.runtime.MessageSender
      , sendResponse: (response: ScreenshotNS.Message) => void): boolean | void => {
    const pending = onMessage(msg, sender)
    if (!pending) { return }
    pending.then(response => { response && sendResponse(response) }, () => {})
    return true
  })
}
