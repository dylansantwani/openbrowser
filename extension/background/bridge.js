/**
 * WebSocket link from the extension to the MCP hub.
 *
 * Two MV3 realities shape this file:
 *
 *  1. The service worker is killed after ~30s idle. An open WebSocket only
 *     keeps it alive while messages are actually flowing, so we heartbeat well
 *     inside that window and keep a chrome.alarms backstop that can respawn the
 *     worker and reconnect after it is torn down anyway.
 *  2. The hub may not exist yet. The extension is usually running before any
 *     MCP client launches the server, so "connection refused" is the normal
 *     steady state, not an error worth shouting about. Reconnection backs off
 *     but never gives up.
 */

import { getSettings } from './settings.js';

const HEARTBEAT_MS = 20_000;   // comfortably under the 30s idle timeout
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export class Bridge {
  /** @param {(tool: string, args: object) => Promise<any>} dispatch */
  constructor(dispatch) {
    this.dispatch = dispatch;
    this.socket = null;

    /**
     * disconnected | connecting | connected
     *
     * Starts as "connecting" whenever we were connected before this worker
     * existed. MV3 destroys the worker after ~30s idle, taking the socket and
     * this object with it, and the fresh instance used to report "not
     * connected" until it had reconnected — so a perfectly healthy setup
     * flashed "not connected" every idle cycle, complete with the
     * troubleshooting help text. The link was never down; only the worker had
     * been recycled, which is normal and not something to alarm anyone about.
     */
    this.status = 'disconnected';
    this.lastError = null;
    this.backoff = BACKOFF_MIN_MS;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.stopped = false;
    this.listeners = new Set();
    this.stats = { calls: 0, errors: 0, connectedAt: null };
  }

  onStatusChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Adopt the connection state that outlived this worker.
   *
   * Called on every worker spawn. If the link was up before the worker was
   * recycled, we are reconnecting, not disconnected — and saying so is the
   * whole point: the previous behaviour showed "not connected" plus the
   * troubleshooting help on every idle cycle of a completely healthy setup,
   * which is how you teach someone to distrust a working status indicator.
   */
  async restore() {
    if (this.status !== 'disconnected' || this.stopped) return;
    try {
      const { bridgeEverConnected } = await chrome.storage.session.get('bridgeEverConnected');
      // Re-check: connect() may have finished while storage was being read.
      if (bridgeEverConnected && this.status === 'disconnected' && !this.stopped) {
        this.status = 'connecting';
        this._emit();
      }
    } catch {
      /* best effort — a wrong-but-cautious label is not worth failing over */
    }
  }

  _emit() {
    const snapshot = this.getStatus();
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch {
        /* a broken listener must not break the bridge */
      }
    }
    // The side panel may be closed; a failed send here is expected.
    chrome.runtime.sendMessage({ type: 'bridge_status', status: snapshot }).catch(() => {});
  }

  getStatus() {
    return {
      status: this.status,
      port: this.port,
      lastError: this.lastError,
      stats: { ...this.stats },
    };
  }

  async connect() {
    this.stopped = false;
    if (this.status === 'connected' || this.status === 'connecting') return;

    const settings = await getSettings();
    this.port = settings.port;
    this.status = 'connecting';
    this._emit();

    // Resolved before the socket exists so the `open` handler stays
    // synchronous: the hello has to be the first frame on the wire, and an
    // await inside `open` would let the heartbeat race it.
    const instance = await instanceId();
    // Held on the bridge so incoming calls can be checked against it without
    // touching storage on every message.
    this.instance = instance;

    const url = `ws://127.0.0.1:${this.port}/ext`;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this._onFailure(err.message);
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.status = 'connected';
      this.lastError = null;
      chrome.storage.session.set({ bridgeEverConnected: true }).catch(() => {});
      this.backoff = BACKOFF_MIN_MS;
      this.stats.connectedAt = Date.now();

      socket.send(
        JSON.stringify({
          type: 'hello',
          role: 'extension',
          version: chrome.runtime.getManifest().version,
          browser: navigatorBrand(),
          // What lets the hub tell "this browser reconnecting" from "a second
          // browser arriving". Without it the two are indistinguishable, and
          // the hub's only safe move was to evict whoever was there — which,
          // with two browsers running, is a permanent disconnect loop. It is
          // also the address every call is stamped with. See `_admit` in hub.js.
          instance,
          // What a human calls this browser, so `browser:"work"` means something.
          name: settings.browserName || '',
        })
      );

      this._startHeartbeat();
      this._emit();
    });

    socket.addEventListener('message', (event) => this._onMessage(event.data));

    socket.addEventListener('close', () => {
      this._stopHeartbeat();
      if (this.socket === socket) {
        this.socket = null;
        this.status = 'disconnected';
        this._emit();
        this._scheduleReconnect();
      }
    });

    socket.addEventListener('error', () => {
      // The 'error' event carries no useful detail by design; 'close' follows
      // and drives the reconnect. Record something legible for the UI.
      this.lastError = `could not reach the hub on port ${this.port}`;
    });
  }

  _onFailure(message) {
    this.lastError = message;
    this.status = 'disconnected';
    this._emit();
    this._scheduleReconnect();
  }

  async _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'hello') return; // hub acknowledging us
    if (msg.type !== 'call') return;

    // Every call is addressed to a specific browser, and this is where the
    // address is checked.
    //
    // Tab ids are only unique *within* a browser: two Chromes each allocate
    // from their own counter, so id 511957184 names a real but different tab in
    // both. A misrouted call therefore does not fail — it succeeds, on the
    // wrong page, silently. That is the worst failure mode this system has, and
    // one comparison removes the whole class.
    const addressed = msg.args?._browser;
    if (addressed != null && this.instance != null && addressed !== this.instance) {
      this._send({
        type: 'result',
        id: msg.id,
        ok: false,
        error: {
          message:
            'this call was addressed to a different browser and was not run. ' +
            'The session is bound to another browser — re-bind it with ' +
            'browser_window action:"use" browser:<name> windowId:<id>.',
        },
      });
      return;
    }

    this.stats.calls++;
    try {
      const result = await this.dispatch(msg.tool, msg.args || {});
      this._send({ type: 'result', id: msg.id, ok: true, result });
    } catch (err) {
      this.stats.errors++;
      this._send({
        type: 'result',
        id: msg.id,
        ok: false,
        error: { message: err?.message || String(err) },
      });
    }
    this._emit();
  }

  _send(obj) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Traffic on the socket is what actually resets the service worker's
      // idle timer, so this is a keepalive in two senses at once.
      if (!this._send({ type: 'ping', t: Date.now() })) this._stopHeartbeat();
    }, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);

    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);

    // setTimeout dies with the service worker. The alarm survives it and wakes
    // us back up, which is what makes reconnection reliable across suspensions.
    chrome.alarms.create('ob-reconnect', { delayInMinutes: 0.5, periodInMinutes: 1 });
  }

  disconnect() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this._stopHeartbeat();
    chrome.alarms.clear('ob-reconnect');
    // Deliberate, so the next worker must not claim it is reconnecting.
    chrome.storage.session.remove('bridgeEverConnected').catch(() => {});
    this.socket?.close();
    this.socket = null;
    this.status = 'disconnected';
    this._emit();
  }

  /** Reconnect using current settings — call after the port changes. */
  async reconnect() {
    this.disconnect();
    this.backoff = BACKOFF_MIN_MS;
    await this.connect();
  }
}

/**
 * A stable id for this browser install, so the hub can tell two browsers apart.
 *
 * `chrome.storage.local`, not `session`: it has to survive a browser restart,
 * or every restart looks to the hub like a brand new browser arriving alongside
 * the one it just lost. Cached in a module variable too, since this is read on
 * every connect and the worker is respawned constantly.
 */
let cachedInstance = null;

async function instanceId() {
  if (cachedInstance) return cachedInstance;
  try {
    const stored = (await chrome.storage.local.get('obInstanceId')).obInstanceId;
    if (stored) return (cachedInstance = stored);
    const fresh = crypto.randomUUID();
    await chrome.storage.local.set({ obInstanceId: fresh });
    return (cachedInstance = fresh);
  } catch {
    // Storage unavailable. A per-worker id is still better than none: it is
    // wrong only across worker restarts, where the cost is one supersede.
    return (cachedInstance = crypto.randomUUID());
  }
}

function navigatorBrand() {
  const brands = navigator.userAgentData?.brands;
  if (!brands?.length) return 'chrome';
  // The list contains a deliberate junk entry ("Not;A Brand") for anti-
  // fingerprinting reasons; skip it.
  const real = brands.find((b) => !/not.a.brand/i.test(b.brand));
  return real ? `${real.brand} ${real.version}` : 'chrome';
}
