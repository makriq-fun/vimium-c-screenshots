/// <reference path="../typings/lib/window.d.ts" />

(function (): void {
  const copyWithSelection = (url: string): Promise<boolean> => new Promise(resolve => {
    const image = new Image()
    image.onload = (): void => {
      try {
        const body = document.body || document.documentElement
        body.appendChild(image)
        const range = document.createRange()
        range.selectNode(image)
        const selection = window.getSelection()
        if (selection) {
          selection.removeAllRanges()
          selection.addRange(range)
        }
        const ok = document.execCommand("copy")
        selection && selection.removeAllRanges()
        image.remove()
        resolve(ok)
      } catch {
        resolve(false)
      }
    }
    image.onerror = (): void => { resolve(false) }
    image.src = url
  })

  chrome.runtime.onMessage.addListener((msg: any, _sender: chrome.runtime.MessageSender
      , sendResponse: (res: { ok: boolean }) => void): boolean | void => {
    if (!msg || msg.target === "vcs-offscreen-ping") { sendResponse({ ok: true }); return }
    if (msg.target !== "vcs-copy-image" || typeof msg.u !== "string") { return }
    console.warn("[vimium-c-screenshots] offscreen: copy image request")
    copyWithSelection(msg.u).then(ok => {
      console.warn("[vimium-c-screenshots] offscreen: copy result", ok)
      sendResponse({ ok })
    }, () => { sendResponse({ ok: false }) })
    return true
  })
})()
