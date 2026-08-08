(() => {
  const CHANNEL = "AWE_WALLET_PROVIDER_V1"
  const pending = new Map()
  let sequence = 0

  function makeId() {
    sequence += 1
    return `${Date.now()}-${sequence}-${Math.random().toString(36).slice(2)}`
  }

  function request(namespace, method, params = []) {
    const id = makeId()
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      window.postMessage({ channel: CHANNEL, direction: "request", id, namespace, method, params }, "*")
      setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        const error = new Error("AWE Wallet request timed out.")
        error.code = -32603
        reject(error)
      }, 5 * 60 * 1000)
    })
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return
    const message = event.data
    if (!message || message.channel !== CHANNEL || message.direction !== "response") return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) {
      const error = new Error(message.error.message || "AWE Wallet request failed.")
      error.code = message.error.code
      error.data = message.error.data
      waiter.reject(error)
    } else {
      waiter.resolve(message.result)
    }
  })

  class Emitter {
    constructor() { this.listeners = new Map() }
    on(event, fn) {
      if (typeof fn !== "function") return this
      const set = this.listeners.get(event) || new Set()
      set.add(fn); this.listeners.set(event, set); return this
    }
    removeListener(event, fn) { this.listeners.get(event)?.delete(fn); return this }
    emit(event, ...args) { this.listeners.get(event)?.forEach((fn) => { try { fn(...args) } catch {} }) }
  }

  class AweEthereumProvider extends Emitter {
    constructor() {
      super()
      this.isAWE = true
      this.isMetaMask = false
      this.chainId = null
      this.selectedAddress = null
    }
    async request({ method, params = [] }) {
      if (!method) throw new Error("AWE Wallet: method is required.")
      const result = await request("eip155", method, params)
      if (method === "eth_requestAccounts" || method === "eth_accounts") {
        this.selectedAddress = result?.[0] || null
        if (method === "eth_requestAccounts") this.emit("accountsChanged", result || [])
      }
      if (method === "eth_chainId") this.chainId = result
      if (method === "wallet_switchEthereumChain") {
        this.chainId = params?.[0]?.chainId || this.chainId
        this.emit("chainChanged", this.chainId)
      }
      return result
    }
    enable() { return this.request({ method: "eth_requestAccounts" }) }
    send(methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === "string") return this.request({ method: methodOrPayload, params: paramsOrCallback || [] })
      const payload = methodOrPayload || {}
      if (typeof paramsOrCallback === "function") {
        this.request(payload).then(
          (result) => paramsOrCallback(null, { id: payload.id, jsonrpc: "2.0", result }),
          (error) => paramsOrCallback(error),
        )
        return undefined
      }
      return this.request(payload)
    }
    sendAsync(payload, callback) { return this.send(payload, callback) }
  }

  const ethereum = new AweEthereumProvider()
  Object.defineProperty(window, "aweEthereum", { value: ethereum, configurable: false })
  if (!window.ethereum) Object.defineProperty(window, "ethereum", { value: ethereum, configurable: true })

  const providerInfo = Object.freeze({
    uuid: "a7e5a8e2-3c31-4fe2-91b9-ae0000000001",
    name: "AWE Wallet",
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='16' fill='%2307111f'/><text x='32' y='40' text-anchor='middle' font-size='25' font-family='Arial' font-weight='700' fill='%235de2e6'>AWE</text></svg>",
    rdns: "com.appswebstore.awewallet",
  })
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: providerInfo, provider: ethereum }) }))
  window.addEventListener("eip6963:requestProvider", announce)
  announce()

  function publicKeyObject(address) {
    if (!address) return null
    return Object.freeze({
      toString: () => address,
      toBase58: () => address,
      toJSON: () => address,
      equals: (other) => String(other?.toBase58?.() || other?.toString?.() || other) === address,
    })
  }

  function bytesToBase64(bytes) {
    let binary = ""
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i])
    return btoa(binary)
  }
  function base64ToBytes(value) {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  function serializeTransaction(transaction) {
    let bytes
    let format = "versioned"
    try {
      bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false })
      format = "legacy"
    } catch {
      bytes = transaction.serialize()
    }
    return { serialized: bytesToBase64(bytes), format }
  }
  function restoreTransaction(original, encoded) {
    const bytes = base64ToBytes(encoded)
    const ctor = original?.constructor
    if (typeof ctor?.deserialize === "function") return ctor.deserialize(bytes)
    if (typeof ctor?.from === "function") return ctor.from(bytes)
    throw new Error("AWE Wallet could not restore the signed Solana transaction.")
  }

  class AweSolanaProvider extends Emitter {
    constructor() {
      super(); this.isAWE = true; this.isConnected = false; this.publicKey = null
    }
    async connect(options = {}) {
      const result = await request("solana", "connect", [options])
      this.publicKey = publicKeyObject(result?.publicKey)
      this.isConnected = Boolean(this.publicKey)
      this.emit("connect", this.publicKey)
      return { publicKey: this.publicKey }
    }
    async disconnect() {
      await request("solana", "disconnect", [])
      this.publicKey = null; this.isConnected = false; this.emit("disconnect")
    }
    async signMessage(message, display = "utf8") {
      const result = await request("solana", "signMessage", [{ message: bytesToBase64(message), display }])
      const key = publicKeyObject(result.publicKey)
      return { signature: base64ToBytes(result.signature), publicKey: key }
    }
    async signTransaction(transaction) {
      const encoded = serializeTransaction(transaction)
      const result = await request("solana", "signTransaction", [encoded])
      return restoreTransaction(transaction, result.signedTransaction)
    }
    async signAllTransactions(transactions) {
      const encoded = transactions.map(serializeTransaction)
      const result = await request("solana", "signAllTransactions", [encoded])
      return result.signedTransactions.map((value, index) => restoreTransaction(transactions[index], value))
    }
    async signAndSendTransaction(transaction, options = {}) {
      const encoded = serializeTransaction(transaction)
      const result = await request("solana", "signAndSendTransaction", [encoded, options])
      return { signature: result.signature }
    }
    async request({ method, params = [] }) { return request("solana", method, params) }
  }

  const solana = new AweSolanaProvider()
  Object.defineProperty(window, "aweSolana", { value: solana, configurable: false })
  if (!window.solana) Object.defineProperty(window, "solana", { value: solana, configurable: true })

  function base58Decode(value) {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    const map = new Map([...alphabet].map((char, index) => [char, index]))
    let bytes = [0]
    for (const char of String(value)) {
      const digit = map.get(char)
      if (digit === undefined) throw new Error("Invalid base58 value.")
      let carry = digit
      for (let i = 0; i < bytes.length; i += 1) {
        const x = bytes[i] * 58 + carry
        bytes[i] = x & 0xff
        carry = x >> 8
      }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8 }
    }
    for (let i = 0; i < value.length - 1 && value[i] === "1"; i += 1) bytes.push(0)
    return Uint8Array.from(bytes.reverse())
  }

  let standardAccount = null
  const standardListeners = new Set()
  function makeStandardAccount(address) {
    return Object.freeze({
      address,
      publicKey: base58Decode(address),
      chains: Object.freeze(["solana:mainnet"]),
      features: Object.freeze(["solana:signMessage", "solana:signTransaction", "solana:signAndSendTransaction"]),
      label: "AWE Wallet",
      icon: providerInfo.icon,
    })
  }
  function emitStandardChange() {
    const properties = { accounts: standardAccount ? [standardAccount] : [] }
    standardListeners.forEach((listener) => { try { listener(properties) } catch {} })
  }

  const standardWallet = Object.freeze({
    version: "1.0.0",
    name: "AWE Wallet",
    icon: providerInfo.icon,
    chains: Object.freeze(["solana:mainnet"]),
    features: Object.freeze({
      "standard:connect": Object.freeze({
        version: "1.0.0",
        connect: async () => {
          const { publicKey } = await solana.connect()
          standardAccount = makeStandardAccount(publicKey.toBase58())
          emitStandardChange()
          return { accounts: [standardAccount] }
        },
      }),
      "standard:disconnect": Object.freeze({
        version: "1.0.0",
        disconnect: async () => {
          await solana.disconnect()
          standardAccount = null
          emitStandardChange()
        },
      }),
      "standard:events": Object.freeze({
        version: "1.0.0",
        on: (event, listener) => {
          if (event !== "change" || typeof listener !== "function") return () => {}
          standardListeners.add(listener)
          return () => standardListeners.delete(listener)
        },
      }),
      "solana:signMessage": Object.freeze({
        version: "1.1.0",
        signMessage: async (...inputs) => Promise.all(inputs.map(async (input) => {
          const result = await solana.signMessage(input.message)
          return { signedMessage: input.message, signature: result.signature }
        })),
      }),
      "solana:signTransaction": Object.freeze({
        version: "1.1.0",
        supportedTransactionVersions: Object.freeze(["legacy", 0]),
        signTransaction: async (...inputs) => Promise.all(inputs.map(async (input) => {
          const result = await request("solana", "signTransaction", [{ serialized: bytesToBase64(input.transaction), format: "auto" }])
          return { signedTransaction: base64ToBytes(result.signedTransaction) }
        })),
      }),
      "solana:signAndSendTransaction": Object.freeze({
        version: "1.0.0",
        supportedTransactionVersions: Object.freeze(["legacy", 0]),
        signAndSendTransaction: async (...inputs) => Promise.all(inputs.map(async (input) => {
          const result = await request("solana", "signAndSendTransaction", [{ serialized: bytesToBase64(input.transaction), format: "auto" }, input.options || {}])
          return { signature: base58Decode(result.signature) }
        })),
      }),
    }),
    get accounts() { return standardAccount ? [standardAccount] : [] },
  })

  const registerStandardWallet = (api) => {
    try { api?.register?.(standardWallet) } catch {}
  }
  window.addEventListener("wallet-standard:app-ready", (event) => registerStandardWallet(event.detail))
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: registerStandardWallet }))

})()
