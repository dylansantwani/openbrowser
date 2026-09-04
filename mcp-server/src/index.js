#!/usr/bin/env node
/**
 * OpenBrowser MCP server — entry point.
 *
 * Usage:
 *   node src/index.js                 run as an MCP stdio server (what clients launch)
 *   node src/index.js --health        print hub + browser status and exit
 *   node src/index.js --hub           run only the hub, no MCP (useful for debugging)
 *   node src/index.js --port 9000     override the hub port (also OPENBROWSER_PORT)
 */

import { statSync } from 'node:fs';

import { createTransport, DEFAULT_PORT, NO_EXTENSION } from './hub.js';
import { McpServer } from './mcp.js';
import { TOOLS, TOOL_NAMES, SERVER_INSTRUCTIONS } from './tools.js';

const VERSION = '1.2.0';

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.OPENBROWSER_PORT) || DEFAULT_PORT,
    // Loopback by default, and that default is load-bearing: the hub has no
    // authentication, so anything that can reach it can run JavaScript in a
    // logged-in browser. Binding elsewhere is always an explicit act.
    host: process.env.OPENBROWSER_HOST || '127.0.0.1',
    connect: (process.env.OPENBROWSER_CONNECT || '').split(',').map((s) => s.trim()).filter(Boolean),
    mode: 'mcp',
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = String(argv[++i]);
    else if (a === '--connect') opts.connect.push(...String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--health' || a === '--doctor') opts.mode = 'health';
    else if (a === '--hub') opts.mode = 'hub';
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--version' || a === '-V') opts.mode = 'version';
    else if (a === '--help' || a === '-h') opts.mode = 'help';
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// stdout is reserved for the protocol stream. Everything human-readable goes to
// stderr, which MCP clients surface in their logs.
const log = (msg) => {
  if (opts.verbose || opts.mode !== 'mcp') process.stderr.write(`[openbrowser] ${msg}\n`);
};

if (opts.mode === 'version') {
  process.stdout.write(`openbrowser ${VERSION}\n`);
  process.exit(0);
}

if (opts.mode === 'help') {
  process.stdout.write(
    `openbrowser ${VERSION} — MCP server for the OpenBrowser Chrome extension\n\n` +
      `  node src/index.js              run as an MCP stdio server\n` +
      `  node src/index.js --health     check whether Chrome is connected\n` +
      `  node src/index.js --hub        run the hub only\n` +
      `  node src/index.js --port N     hub port (default ${DEFAULT_PORT})\n` +
      `  node src/index.js --host H     bind address (default 127.0.0.1;\n` +
      `                                 use 0.0.0.0 to accept remote hubs)\n` +
      `  node src/index.js --connect A  attach to remote hub(s), comma separated\n` +
      `  node src/index.js --verbose    log to stderr\n`
  );
  process.exit(0);
}

if (opts.mode === 'health') {
  await runHealthCheck(opts.port);
  process.exit(0);
}

const transport = await createTransport({ port: opts.port, host: opts.host, log });

if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
  log(
    `listening on ${opts.host} — this hub has no authentication, so anyone who can reach ` +
      `${opts.host}:${opts.port} can drive its browsers. Keep it on a private network.`
  );
}

// Attach remote hubs named at startup, so a cloud box can be wired up from a
// systemd unit rather than an agent having to issue `connect` every session.
// Routed through `call` rather than the Hub method directly, so it behaves the
// same whether this process won the port or joined someone else's hub.
for (const address of opts.connect) {
  try {
    const res = await transport.call('browser_window', { action: 'connect', hub: address });
    log(res?.text || `connected to remote hub at ${address}`);
  } catch (err) {
    log(`could not connect to remote hub at ${address}: ${err.message}`);
  }
}

if (opts.mode === 'hub') {
  log('hub-only mode; press Ctrl+C to stop');
  // Keep the process alive; the hub owns a listening socket either way.
  await new Promise(() => {});
}

/**
 * This session's name — one word, allocated by the hub: "harbor".
 *
 * It used to be `client · word` ("claude-code · harbor"), and that composite
 * was the single most confusing thing a human or a model met here. The tab
 * strip, the on-page frame, the panel, and every error all carried a two-part
 * label whose first half was the same for every session of one client and
 * whose second half was the only part that meant anything. The hub already
 * guarantees the word is unique across every client it serves, so the prefix
 * bought nothing — the session *is* the word now, and the same word appears
 * everywhere. Which MCP client a session belongs to still matters to a person
 * looking at the panel, so it rides along on every call as `_client`, metadata
 * the browser records against the session and never uses as identity.
 */
let sessionLabel = null;

function sessionName() {
  if (sessionLabel) return sessionLabel;

  // The name normally comes from the hub, the only place that can see every
  // live session and so the only one that can guarantee two never collide onto
  // the same tab group.
  //
  // When it does not — an older hub owner that predates name allocation — the
  // name MUST still be unique. Falling back to a bare client name put every
  // session of the same client into one shared tab group, driving each other's
  // tabs. A degraded name is fine; a non-unique one is not.
  let name = transport.sessionName;
  if (!name) {
    name = `${clientName()}-${process.pid.toString(16).slice(-4)}`;
    log(
      `hub did not assign a session name — it is running an older version. ` +
        `Using "${name}"; restart the first-started MCP client for readable names and tab cleanup.`
    );
  }
  sessionLabel = name;
  // Tell the hub the label this session's tab group actually carries, so its
  // cleanup on disconnect looks for the right group and reserves the right name.
  transport.setSessionLabel?.(sessionLabel);
  return sessionLabel;
}

/** The MCP client's own name for itself ("claude-code", "opencode"), for display. */
function clientName() {
  return String(server?.clientInfo?.name || 'mcp').trim() || 'mcp';
}

const server = new McpServer({
  serverInfo: { name: 'openbrowser', version: VERSION },
  instructions: SERVER_INSTRUCTIONS,
  tools: TOOLS,
  log,
  onCall: async (name, args) => {
    if (!TOOL_NAMES.has(name)) throw new Error(`unknown tool: ${name}`);

    checkArgs(name, args);
    if (name === 'browser_batch') for (const step of args.steps || []) checkArgs(step.tool, step.args);
    if (name === 'browser_upload') checkPaths(args.paths);

    // Hub-level questions must work with nothing attached — `connect` is how a
    // browser becomes reachable in the first place, so waiting for one here
    // would make a hub whose browsers are all remote impossible to bootstrap.
    const hubOnly =
      name === 'browser_window' && ['connect', 'disconnect', 'remotes'].includes(args.action);

    if (!hubOnly && !transport.connected) {
      // Give a just-launched Chrome a moment to connect before failing — MCP
      // clients often start the server before the browser is up.
      try {
        await transport.waitForExtension(8000);
      } catch {
        throw new Error(NO_EXTENSION);
      }
    }

    // GIF recording and long waits legitimately outrun the default budget.
    const timeout = timeoutFor(name, args);

    // Every call carries the session name. The browser uses it to own and group
    // this session's tabs; an explicit `group` argument splits that session's
    // own tabs into named sub-groups and never changes who owns them.
    //
    // Stamped *after* the spread, and that order is load-bearing. `checkArgs`
    // deliberately exempts underscore-prefixed keys, so a model emitting
    // `_session: "harbor"` passes validation — and with the spread last it would
    // overwrite this one and be handed another session's tabs. Identity is
    // asserted here or nowhere. `_client` is display metadata for the panel and
    // is stamped the same way so a model cannot mislabel itself either.
    return transport.call(
      name,
      { ...args, _session: sessionName(), _client: clientName() },
      { timeout }
    );
  },
}).start();

log(`MCP server ready (${TOOLS.length} tools)`);

const SCHEMAS = new Map(TOOLS.map((t) => [t.name, t.inputSchema]));

/**
 * Accepted by every tool, though declared only on browser_tabs: the router
 * reads it for session grouping regardless of which tool was called.
 */
const UNIVERSAL_ARGS = new Set(['group']);

/**
 * Reject arguments a tool does not have.
 *
 * Dropping unknown keys in silence is the worst option available. A call of
 * `browser_navigate {url, newTab: true}` looked like it had done what was
 * asked; there is no `newTab` parameter, so it drove whatever tab happened to
 * be active instead — in a browser shared with other agents, someone else's,
 * mid-task. Listing the parameters the tool does take is enough for a caller to
 * correct itself on the next turn.
 */
function checkArgs(name, args) {
  const schema = SCHEMAS.get(name);
  if (!schema?.properties) return;

  const known = Object.keys(schema.properties);
  const unknown = Object.keys(args || {}).filter(
    (k) => !k.startsWith('_') && !UNIVERSAL_ARGS.has(k) && !known.includes(k)
  );
  if (!unknown.length) return;

  throw new Error(
    `unknown parameter${unknown.length > 1 ? 's' : ''} for ${name}: ${unknown.join(', ')} — nothing was done. ` +
      `${name} accepts: ${known.join(', ')}.`
  );
}

/**
 * Reject upload paths that do not exist before anything is dispatched.
 *
 * `DOM.setFileInputFiles` does not validate, and the extension has no
 * filesystem to validate against — so a stale path produced a cheerful
 * "attached 1 file(s)" followed by an upload stuck at 0% forever. This process
 * is the only place in the stack with `fs`, and the hub only ever binds
 * 127.0.0.1, so the browser is on this same machine and the check is sound.
 */
function checkPaths(paths) {
  if (!Array.isArray(paths) || !paths.length) return;

  // Federated hubs: the browser runs on a different machine, so the file
  // legitimately exists there but not here. The local stat is only sound when
  // the browser is on this machine (see the note below). When remote hubs are
  // attached, skip the check — the browser's own file chooser still validates.
  if (process.env.OPENBROWSER_TRUST_REMOTE_PATHS || transport.remotes?.size > 0) return;

  const bad = [];
  for (const path of paths) {
    try {
      if (!statSync(path).isFile()) bad.push(`${path} (not a file)`);
    } catch {
      bad.push(path);
    }
  }

  if (bad.length) {
    throw new Error(
      `no such file: ${bad.join(', ')} — nothing was attached. ` +
        'Paths are absolute and on the machine running Chrome; use forward slashes ("C:/Users/...").'
    );
  }
}

function timeoutFor(name, args) {
  if (name === 'browser_wait') return (args.timeout ?? 15_000) + 5_000;
  if (name === 'browser_navigate') return (args.timeout ?? 30_000) + 5_000;
  if (name === 'browser_screenshot' && args.animate) {
    const { frames = 12, intervalMs = 400 } = args.animate;
    return frames * intervalMs + 30_000;
  }
  if (name === 'browser_batch' || name === 'browser_macro') return 300_000;
  return undefined; // hub default
}

async function runHealthCheck(port) {
  const url = `http://127.0.0.1:${port}/health`;
  let payload;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    payload = await res.json();
  } catch {
    process.stdout.write(
      `hub:       not running on port ${port}\n` +
        `browser:   unknown\n\n` +
        `Nothing is listening yet. That is expected until an MCP client launches\n` +
        `this server, or you start one manually with --hub.\n`
    );
    return;
  }

  process.stdout.write(
    `hub:       running on port ${port}\n` +
      `browser:   ${payload.extensionConnected ? `connected (${payload.browser || 'chrome'})` : 'NOT connected'}\n` +
      `mcp peers: ${payload.peers ?? 0}\n`
  );

  if (!payload.extensionConnected) {
    process.stdout.write(
      `\nThe hub is up but Chrome has not connected. Check that:\n` +
        `  1. The OpenBrowser extension is installed and enabled at chrome://extensions\n` +
        `  2. Its port setting matches ${port} (extension options page)\n` +
        `  3. The extension's service worker is running — click "service worker" to wake it\n`
    );
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await transport.stop?.();
    process.exit(0);
  });
}
