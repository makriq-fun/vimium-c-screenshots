/// <reference path="../typings/lib/window.d.ts" />

(function (): void {
  const clipboard = navigator.clipboard
  const fetch_ = (window as unknown as { fetch: (url: string) => Promise<{ blob(): Promise<Blob> }> }).fetch
  if (!clipboard || !clipboard.write || typeof ClipboardItem !== "function") {
    chrome.runtime.onMessage.addListener((): void => {
      /* clipboard images are unsupported */
    })
    return
  }
  chrome.runtime.onMessage.addListener((msg: any, _sender: chrome.runtime.MessageSender
      , sendResponse: (res: { ok: boolean }) => void): boolean | void => {
    if (!msg || msg.target === "vcs-offscreen-ping") { sendResponse({ ok: true }); return }
    if (msg.target !== "vcs-copy-image" || typeof msg.u !== "string") { return }
    console.warn("[vimium-c-screenshots] offscreen: copy image request")
    fetch_(msg.u).then(res => res.blob()).then(blob => {
      return clipboard.write!([new ClipboardItem({ "image/png": blob })])
    }).then(() => {
      console.warn("[vimium-c-screenshots] offscreen: clipboard ok")
      sendResponse({ ok: true })
    }, (err: unknown) => {
      console.warn("[vimium-c-screenshots] offscreen: clipboard failed", "" + err)
      sendResponse({ ok: false })
    })
    return true
  })
})()
