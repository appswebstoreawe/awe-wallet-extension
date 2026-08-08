(() => {
  const ext = globalThis.browser || globalThis.chrome
  const CHANNEL = "AWE_WALLET_PROVIDER_V1"

  const script = document.createElement("script")
  script.src = ext.runtime.getURL("inpage.js")
  script.async = false
  ;(document.head || document.documentElement).appendChild(script)
  script.onload = () => script.remove()

  window.addEventListener("message", (event) => {
    if (event.source !== window) return
    const message = event.data
    if (!message || message.channel !== CHANNEL || message.direction !== "request") return

    ext.runtime.sendMessage({
      type: "AWE_DAPP_REQUEST",
      request: {
        id: message.id,
        namespace: message.namespace,
        method: message.method,
        params: message.params ?? [],
        origin: window.location.origin,
        title: document.title || window.location.hostname,
      },
    }).catch((error) => {
      window.postMessage({
        channel: CHANNEL,
        direction: "response",
        id: message.id,
        error: { code: -32603, message: error?.message || "AWE Wallet request failed." },
      }, "*")
    })
  })

  ext.runtime.onMessage.addListener((message) => {
    if (message?.type !== "AWE_DAPP_RESPONSE") return
    window.postMessage({
      channel: CHANNEL,
      direction: "response",
      id: message.id,
      result: message.result,
      error: message.error,
    }, "*")
  })
})()
