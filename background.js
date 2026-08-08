const ext = globalThis.browser || globalThis.chrome
const DEFAULT_CHAIN_ID = "0x1"
const EVM_RPCS = {
  "0x1": "https://ethereum-rpc.publicnode.com",
  "0x38": "https://bsc-rpc.publicnode.com",
}

function pendingKey(id) { return `awe_pending_${id}` }

async function getSettings() {
  const data = await ext.storage.local.get(["awe_evm_chain_id", "awe_evm_connections", "awe_solana_connections"])
  return {
    chainId: data.awe_evm_chain_id || DEFAULT_CHAIN_ID,
    evmConnections: data.awe_evm_connections || {},
    solanaConnections: data.awe_solana_connections || {},
  }
}

async function sendToTab(tabId, id, result, error, frameId = 0) {
  try {
    await ext.tabs.sendMessage(tabId, { type: "AWE_DAPP_RESPONSE", id, result, error }, { frameId })
  } catch {}
}

async function rpc(chainId, method, params) {
  const url = EVM_RPCS[chainId]
  if (!url) throw Object.assign(new Error("Unsupported EVM network."), { code: 4902 })
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  })
  const body = await response.json()
  if (body.error) {
    const error = new Error(body.error.message || "RPC request failed.")
    error.code = body.error.code
    error.data = body.error.data
    throw error
  }
  return body.result
}

function requiresApproval(namespace, method) {
  if (namespace === "eip155") {
    return [
      "eth_requestAccounts",
      "personal_sign",
      "eth_sign",
      "eth_signTypedData",
      "eth_signTypedData_v3",
      "eth_signTypedData_v4",
      "eth_sendTransaction",
      "eth_signTransaction",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
    ].includes(method)
  }
  if (namespace === "solana") {
    return ["connect", "signMessage", "signTransaction", "signAllTransactions", "signAndSendTransaction"].includes(method)
  }
  return false
}

async function openApproval(request, sender) {
  const pending = {
    ...request,
    tabId: sender.tab?.id,
    frameId: sender.frameId || 0,
    createdAt: Date.now(),
  }
  await ext.storage.session.set({ [pendingKey(request.id)]: pending })
  const url = ext.runtime.getURL(`index.html#/approve?id=${encodeURIComponent(request.id)}`)
  await ext.windows.create({ url, type: "popup", width: 430, height: 720, focused: true })
}

async function handleRequest(request, sender) {
  const { namespace, method, params = [], origin } = request
  const settings = await getSettings()

  if (namespace === "eip155") {
    if (method === "eth_chainId") return settings.chainId
    if (method === "net_version") return String(parseInt(settings.chainId, 16))
    if (method === "eth_accounts") {
      const address = settings.evmConnections[origin]
      return address ? [address] : []
    }
    if (!requiresApproval(namespace, method)) return rpc(settings.chainId, method, params)
  }

  if (namespace === "solana") {
    if (method === "disconnect") {
      const next = { ...settings.solanaConnections }
      delete next[origin]
      await ext.storage.local.set({ awe_solana_connections: next })
      return null
    }
    if (!requiresApproval(namespace, method)) throw Object.assign(new Error(`Unsupported Solana method: ${method}`), { code: -32601 })
  }

  await openApproval(request, sender)
  return { __awePending: true }
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AWE_DAPP_REQUEST") {
    ;(async () => {
      try {
        const result = await handleRequest(message.request, sender)
        if (!result?.__awePending) await sendToTab(sender.tab?.id, message.request.id, result, null, sender.frameId || 0)
        sendResponse({ ok: true })
      } catch (error) {
        const payload = { code: error?.code ?? -32603, message: error?.message || "AWE Wallet request failed.", data: error?.data }
        await sendToTab(sender.tab?.id, message.request.id, null, payload, sender.frameId || 0)
        sendResponse({ ok: false, error: payload })
      }
    })()
    return true
  }

  if (message?.type === "AWE_GET_PENDING") {
    ;(async () => {
      const key = pendingKey(message.id)
      const data = await ext.storage.session.get(key)
      sendResponse(data[key] || null)
    })()
    return true
  }

  if (message?.type === "AWE_RESOLVE_PENDING") {
    ;(async () => {
      const key = pendingKey(message.id)
      const data = await ext.storage.session.get(key)
      const pending = data[key]
      if (!pending) {
        sendResponse({ ok: false, error: "Request expired." })
        return
      }

      if (!message.error) {
        const settings = await getSettings()
        if (pending.namespace === "eip155" && pending.method === "eth_requestAccounts") {
          const address = message.result?.[0]
          if (address) await ext.storage.local.set({ awe_evm_connections: { ...settings.evmConnections, [pending.origin]: address } })
        }
        if (pending.namespace === "eip155" && pending.method === "wallet_switchEthereumChain") {
          const chainId = pending.params?.[0]?.chainId
          if (EVM_RPCS[chainId]) await ext.storage.local.set({ awe_evm_chain_id: chainId })
        }
        if (pending.namespace === "solana" && pending.method === "connect") {
          const address = message.result?.publicKey
          if (address) await ext.storage.local.set({ awe_solana_connections: { ...settings.solanaConnections, [pending.origin]: address } })
        }
      }

      await sendToTab(pending.tabId, pending.id, message.result, message.error || null, pending.frameId || 0)
      await ext.storage.session.remove(key)
      sendResponse({ ok: true })
    })()
    return true
  }
})
