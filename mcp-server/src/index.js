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

const VERSION = '1.0.0';

function parseArgs(argv) {
  const opts = { port: Number(process.env.OPENBROWSER_PORT) || DEFAULT_PORT, mode: 'mcp', verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]);
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
      `  node src/index.js --verbose    log to stderr\n`
  );
  process.exit(0);
}

if (opts.mode === 'health') {
  await runHealthCheck(opts.port);
  process.exit(0);
}

const transport = await createTransport({ port: opts.port, log });

if (opts.mode === 'hub') {
  log('hub-only mode; press Ctrl+C to stop');
  // Keep the process alive; the hub owns a listening socket either way.
  await new Promise(() => {});
}

/**
 * Stable label for this server process, used to name the browser tab group.
 *
 * The point is legibility when several agents are running at once: a window
 * full of tabs is meaningless, whereas "opencode 6f2a" next to "claude 91c3"
 * tells you immediately who opened what — and which group is safe to close.
 * The suffix disambiguates two instances of the same client.
 */
let sessionLabel = null;

function sessionName() {
  if (sessionLabel) return sessionLabel;
  const client = server?.clientInfo?.name || 'mcp';

  // The distinguishing half normally comes from the hub, the only place that
  // can see every live session and so the only one that can guarantee two never
  // collide onto the same tab group.
  //
  // When it does not — an older hub owner that predates name allocation — the
  // suffix MUST still come from somewhere. Falling back to a bare client name
  // put every session of the same client into one shared tab group, driving
  // each other's tabs. A degraded name is fine; a non-unique one is not.
  let name = transport.sessionName;
  if (!name) {
    name = process.pid.toString(16).slice(-4);
    log(
      `hub did not assign a session name — it is running an older version. ` +
        `Using "${name}"; restart the first-started MCP client for readable names and tab cleanup.`
    );
  }
  sessionLabel = `${client} · ${name}`;
  // The hub allocated the unique half but cannot know the client's name, so it
  // has to be told the label the tab group will actually carry — otherwise its
  // cleanup on disconnect looks for a workstream that does not exist.
  transport.setSessionLabel?.(sessionLabel);
  return sessionLabel;
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

    if (!transport.connected) {
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

    // Every call carries the session label. The browser uses it to group this
    // session's tabs; an explicit `group` argument still wins, so an agent can
    // still split its own work into sub-workstreams.
    return transport.call(name, { _session: sessionName(), ...args }, { timeout });
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
