/**
 * Tool surface exposed over MCP.
 *
 * Design rules, because these descriptions are re-sent on every single request
 * and are the largest fixed token cost of the whole integration:
 *
 *  1. Fourteen tools, not forty. Related verbs collapse into one tool with an
 *     `action` enum. A model picks an enum value more reliably than it picks
 *     between `click_element` and `element_click`.
 *  2. Descriptions state what the tool does and the one thing that is easy to
 *     get wrong. No prose, no examples that the model can infer.
 *  3. `tabId` is always optional and always defaults to the active tab. Most
 *     sessions are single-tab; making it required taxes every call.
 *  4. Every mutating tool returns a compact post-action page delta, so the
 *     model rarely needs a follow-up snapshot. That is the single biggest
 *     token saving in the design.
 */

/** Shared param fragments, so wording stays identical across tools. */
const TAB = {
  type: 'number',
  description: 'Tab to act on. Omit for your last tab.',
};

const REF = {
  type: 'string',
  description: 'Element ref from browser_snapshot/browser_find, e.g. "e12".',
};

const COORD = {
  type: 'array',
  items: { type: 'number' },
  minItems: 2,
  maxItems: 2,
  description: 'Viewport CSS pixels [x,y]. Prefer ref; use coords only for canvas/maps/PDF.',
};

/**
 * Verify-in-the-same-call. "Did it work?" used to be its own round trip (act,
 * wait, snapshot); folding the wait into the action removes a model turn from
 * nearly every click that matters.
 */
const EXPECT = {
  type: 'object',
  description:
    'Verify in this call: {for, value, timeout?}, a browser_wait condition, e.g. {for:"text", value:"Order placed"}. Blocks until met (default 5s); a miss is an error, so a batch stops there.',
};

/** A browser_wait condition, answered instantly — the gate on a batch step. */
const COND = { type: 'object' };

export const TOOLS = [
  {
    name: 'browser_tabs',
    description:
      'List, open, close, select, or reload your tabs. Every other tool takes a tabId, so many sites can be driven in parallel. Optional "group" splits your tabs into named, coloured sub-groups.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'new', 'close', 'select', 'reload', 'duplicate', 'group', 'ungroup', 'close_group'],
          description: 'Default "list".',
        },
        group: {
          type: 'string',
          description: 'Optional sub-group label; omit for normal work. Splits your own tabs into named tab groups.',
        },
        tabId: TAB,
        tabIds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Batch close/reload/group several tabs.',
        },
        url: { type: 'string', description: 'For "new". Defaults to about:blank.' },
        background: {
          type: 'boolean',
          description: 'For "new": open unfocused. Default true, so parallel work keeps focus.',
        },
        windowId: { type: 'number', description: 'For "new": target window. For "list": that window in full.' },
      },
    },
  },

  {
    name: 'browser_navigate',
    description:
      'Go to a URL, or move through history. Waits for the page to settle and returns the resulting URL, title, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB,
        url: {
          type: 'string',
          description: 'Absolute or scheme-less URL (https:// assumed), or "back" / "forward" / "reload".',
        },
        waitUntil: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle', 'none'],
          description: 'Default "load". Use "networkidle" for SPAs that hydrate after load.',
        },
        timeout: { type: 'number', description: 'ms. Default 30000.' },
      },
      required: ['url'],
    },
  },

  {
    name: 'browser_snapshot',
    description:
      'Read the page as a compact accessibility tree with [ref=eN] handles on every interactive element. The primary way to see a page — screenshots cost ~20x more. Refs stay valid until the DOM changes materially.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB,
        mode: {
          type: 'string',
          enum: ['interactive', 'full', 'text', 'diff', 'outline'],
          description:
            'interactive (default): controls + structure. full: adds static text. text: plain text, no refs. diff: only what changed since the last snapshot — use in loops. outline: landmarks + headings with control counts and a selector each — the cheap first look at a big page; then scope with selector.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector to scope the snapshot to one region. Big token saver on dense pages.',
        },
        maxChars: { type: 'number', description: 'Truncation budget. Default 8000; a truncated read ends with an outline to scope by.' },
        frames: {
          type: 'boolean',
          description: 'Include same- and cross-origin iframes. Default true.',
        },
        viewportOnly: {
          type: 'boolean',
          description: 'Only elements currently in the viewport. Default false.',
        },
      },
    },
  },

  {
    name: 'browser_find',
    description:
      'Find elements by description ("blue checkout button", "email field"). Returns ranked refs with context to disambiguate. Cheaper than a snapshot when you know what you want.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB,
        query: { type: 'string', description: 'What to look for.' },
        selector: {
          type: 'string',
          description: 'CSS selector to scope the search. Use it when a find returns nothing on a large page.',
        },
        limit: { type: 'number', description: 'Default 10.' },
        interactiveOnly: { type: 'boolean', description: 'Default true.' },
      },
      required: ['query'],
    },
  },

  {
    name: 'browser_act',
    description:
      'Pointer and element actions. Dispatches real trusted input events, so it works on sites that ignore synthetic ones (Stripe, Google, banking, canvas). Auto-scrolls the target into view. action:"google_login" guides a "Sign in with Google" flow (lists accounts, asks the user which; never a password).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB,
        action: {
          type: 'string',
          enum: [
            'click', 'double_click', 'right_click', 'middle_click',
            'hover', 'focus', 'blur', 'scroll', 'scroll_to',
            'drag', 'select_option', 'check', 'uncheck', 'clear', 'submit',
            'dialog', 'google_login',
          ],
        },
        accept: {
          type: 'boolean',
          description: 'For "dialog": true = OK/Leave, false = Cancel/Stay.',
        },
        account: {
          type: 'string',
          description: 'For "google_login": which account (email or index). Omit to list them and ask the user.',
        },
        consent: {
          type: 'boolean',
          description: 'For "google_login": true only after the user confirms granting access.',
        },
        promptText: {
          type: 'string',
          description: 'For "dialog": text to type for prompt().',
        },
        ref: REF,
        coordinate: COORD,
        space: {
          type: 'string',
          enum: ['css', 'image'],
          description: '"image": coords read off the last browser_screenshot (auto-converted to viewport px). Default "css".',
        },
        mark: {
          type: 'number',
          description: 'Click badge N from the last marks:true screenshot (resolves to that element; no pixel math).',
        },
        direction: {
          type: 'string',
          enum: ['down', 'up', 'left', 'right'],
          description: 'For "scroll". Default "down".',
        },
        amount: { type: 'number', description: 'For "scroll": pixels. Default 400.' },
        to: { ...COORD, description: 'For "drag": destination [x,y].' },
        toRef: { type: 'string', description: 'For "drag": destination ref.' },
        value: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: 'For "select_option": option label(s) or value(s).',
        },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
        },
        force: {
          type: 'boolean',
          description: 'Skip the visible/enabled precheck and click anyway. For overlay-covered targets.',
        },
        expect: EXPECT,
      },
      required: ['action'],
    },
  },

  {
    name: 'browser_input',
    description:
      'Type text, fill many fields at once, or press keys. Filling a whole form in one call is far cheaper than one call per field.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB,
        fields: {
          type: 'array',
          description: 'Fill several inputs at once. Each entry targets one ref.',
          items: {
            type: 'object',
            properties: {
              ref: REF,
              value: {
                type: ['string', 'boolean'],
                description: 'Text for inputs; boolean for checkboxes/radios.',
              },
              clear: { type: 'boolean', description: 'Clear first. Default true.' },
            },
            required: ['ref', 'value'],
          },
        },
        text: { type: 'string', description: 'Type into `ref`, or into whatever has focus.' },
        ref: REF,
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'e.g. ["Enter"], ["Control+a"], ["Tab","Tab"]. Sent after text/fields; pass `ref` to focus first.',
        },
        newline: {
          type: 'string',
          enum: ['paragraph', 'soft'],
          description: 'How "\\n" in `text` breaks lines. "soft" (Shift+Enter) avoids the blank line rich editors add.',
        },
        submit: { type: 'boolean', description: 'Press Enter when done. Default false.' },
        delay: { type: 'number', description: 'ms between keystrokes. Raise for inputs with aggressive JS masking.' },
        expect: EXPECT,
      },
    },
  },

  {
    name: 'browser_screenshot',
    description:
      'Capture the page as an image. Costs ~20x a snapshot; use it when stuck, for canvas/video/PDF, or visual verification. To read one element (chart/canvas/svg/image), use mode:"element" with a selector. Image coordinates work with browser_act space:"image".',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB,
        mode: {
          type: 'string',
          enum: ['viewport', 'full_page', 'element', 'region'],
          description: 'Default "viewport". "element" frames one element — with a selector, or alone auto-frames the main chart/image.',
        },
        ref: REF,
        selector: {
          type: 'string',
          description:
            'For "element": CSS selector (e.g. "canvas", "svg") to frame that element exactly — the reliable way to capture something with no ref: whole element, native resolution, never clipped.',
        },
        region: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description:
            'For "region": [x,y,width,height] in viewport px. Last resort — a guessed rect clips the target; prefer mode:"element" with a selector.',
        },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Default jpeg (much smaller).' },
        quality: { type: 'number', description: 'jpeg only, 1-100. Default 70.' },
        maxWidth: { type: 'number', description: 'Downscale to this width. Default 1280.' },
        marks: {
          type: 'boolean',
          description: 'Number every clickable element with a badge; click one via browser_act mark:N. Reliable on canvas apps (Docs, Figma) and dense UIs — no pixel guessing.',
        },
        animate: {
          type: 'object',
          description: 'Record an animated GIF instead of a still.',
          properties: {
            frames: { type: 'number', description: 'Default 12.' },
            intervalMs: { type: 'number', description: 'Default 400.' },
          },
        },
      },
    },
  },

  {
    name: 'browser_wait',
    description:
      'Block until a condition holds. Use instead of guessing at sleeps, which flake on slow sites.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB,
        for: {
          type: 'string',
          enum: ['text', 'no_text', 'selector', 'no_selector', 'ref_gone', 'url', 'network_idle', 'load', 'time', 'job'],
          description: '"job": collect an async batch by id; no value lists your jobs.',
        },
        value: { type: 'string', description: 'The text, selector, ref, URL substring/regex, or job id to wait for.' },
        timeout: { type: 'number', description: 'ms. Default 15000.' },
      },
      required: ['for'],
    },
  },

  {
    name: 'browser_eval',
    description:
      'Run JavaScript in the page and return the result. For reading computed state or scraping structured data in one shot. Prefer browser_act for interaction — clicks from here are untrusted and widely rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB,
        code: {
          type: 'string',
          // Regex literals are the single most common reason a call to this tool
          // fails before it ever reaches the page: `\d` is not a valid JSON
          // escape, so the arguments are rejected during parsing.
          description:
            'One expression (its value is returned), or a function body with an explicit `return`. ' +
            'Top-level await is allowed. No regex literals — JSON rejects \\d; use new RegExp("[0-9]") or string methods.',
        },
        world: {
          type: 'string',
          enum: ['isolated', 'main'],
          description: 'Default "main" — needed to see page variables like window.__NEXT_DATA__.',
        },
        ref: { ...REF, description: 'Binds that element to `element` in your code.' },
        frameId: { type: 'number', description: 'Run inside a specific iframe.' },
        timeout: { type: 'number', description: 'ms. Default 10000.' },
      },
      required: ['code'],
    },
  },

  {
    name: 'browser_inspect',
    description:
      'Read out-of-band state: console, network, cookies, storage, downloads, page summary. Console and network are captured continuously, so this works retroactively.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB,
        what: {
          type: 'string',
          enum: ['console', 'network', 'request_body', 'cookies', 'storage', 'downloads', 'page_info', 'frames'],
        },
        filter: { type: 'string', description: 'Substring or /regex/ over message text or request URL.' },
        level: {
          type: 'string',
          enum: ['all', 'error', 'warn'],
          description: 'Console only. Default "all".',
        },
        requestId: { type: 'string', description: 'For "request_body": which request to fetch bodies for.' },
        limit: { type: 'number', description: 'Default 50, newest first.' },
        since: { type: 'number', description: 'Only entries after this ms timestamp — for polling loops.' },
        includePrevious: { type: 'boolean', description: 'Include entries from before the last navigation.' },
      },
      required: ['what'],
    },
  },

  {
    name: 'browser_batch',
    description:
      'Prefer this to one call at a time whenever you can name the next 2+ steps — each call is a full round-trip. Steps run in order with when/unless/repeat control flow; "parallel" fans them across tabs; async:true returns at once.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { ...TAB, description: 'Default tab for every step. A step may still set its own.' },
        steps: {
          type: 'array',
          description: 'Each step is {tool, args} plus optional when/unless/repeat. Refs from one step are visible to later steps.',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'Any browser_* tool name except browser_batch.' },
              args: { type: 'object' },
              when: { ...COND, description: 'Run only if this browser_wait-style condition {for, value} holds now.' },
              unless: { ...COND, description: 'Run only if it does not hold now.' },
              repeat: {
                type: ['object', 'number'],
                description: 'Rerun: {until|while: cond, max?} (default 10, cap 50) or a count. "click Next until gone" is one step.',
              },
              steps: { type: 'array', description: 'Sub-steps run as one unit under this step\'s when/unless/repeat.' },
            },
          },
        },
        async: {
          type: 'boolean',
          description: 'Return a job id at once and run in the background; collect with browser_wait for:"job" value:<id>.',
        },
        parallel: {
          type: 'array',
          items: { type: 'number' },
          description: 'Run `steps` concurrently against each of these tabIds.',
        },
        stopOnError: { type: 'boolean', description: 'Default true.' },
        returnEach: {
          type: 'boolean',
          description: 'Return every step result. Default false — only the last.',
        },
      },
      required: ['steps'],
    },
  },

  {
    name: 'browser_upload',
    description: 'Attach local files to a file input, including one hidden behind a custom "Browse" button.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB,
        ref: { ...REF, description: 'The file input, or the button that opens it.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute paths on the machine running the browser. Use forward slashes — "C:\\Users" is invalid JSON.',
        },
      },
      required: ['paths'],
    },
  },

  {
    name: 'browser_window',
    description:
      'Pick the Chrome window this session works in, here or on another machine (action:"connect"); resize/emulate a device/force light-dark/zoom/throttle.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'new', 'use', 'pick', 'browsers', 'connect', 'disconnect', 'remotes'],
          description:
            'Where this session works. "list" windows; "new" gives it one of its own, right if the user is browsing; "browsers" lists them; "use" takes browser and/or windowId; "pick" asks the user. Only when a call reports several — relay the list, never guess. "connect" hub:<host> adds another machine\'s browsers as "remote/browser"; also "remotes", "disconnect".',
        },
        windowId: { type: 'number', description: 'For "use".' },
        browser: { type: 'string', description: 'For "use": browser name.' },
        hub: { type: 'string', description: 'host[:port], or wss://host if published behind TLS.' },
        tabId: TAB,
        preset: { type: 'string', enum: ['mobile', 'tablet', 'desktop', 'wide'] },
        width: { type: 'number' },
        height: { type: 'number' },
        colorScheme: { type: 'string', enum: ['light', 'dark', 'no-preference'] },
        zoom: { type: 'number', description: 'Page zoom factor, e.g. 1.5.' },
        userAgent: { type: 'string' },
        throttle: {
          type: 'string',
          enum: ['none', 'slow3g', 'fast3g', 'offline'],
          description: 'Emulate a slow or absent network.',
        },
        focus: { type: 'boolean', description: 'Make the tab the visible one in its window. Never raises the window.' },
        state: {
          type: 'string',
          enum: ['normal', 'minimized', 'maximized', 'fullscreen'],
          description: 'Reads keep working while minimized; input un-minimizes it first.',
        },
      },
    },
  },

  {
    name: 'browser_macro',
    description:
      'Save a step sequence under a name and replay it later — logins, search-and-extract, checkouts. Replay is one call, far cheaper than re-deriving the flow.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'save', 'run', 'delete', 'show'] },
        name: { type: 'string' },
        description: { type: 'string', description: 'Shown in "list" so future you knows what it does.' },
        steps: {
          type: 'array',
          description: 'For "save": same shape as browser_batch steps. May contain {{placeholders}}.',
          items: { type: 'object' },
        },
        vars: { type: 'object', description: 'For "run": values substituted into {{placeholders}}.' },
        tabId: TAB,
      },
      required: ['action'],
    },
  },
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/**
 * Instructions surfaced once at MCP initialize time. Cheaper than repeating
 * strategy inside every tool description.
 */
export const SERVER_INSTRUCTIONS = `Drive a real Chrome browser through the OpenBrowser extension.

Workflow that works: browser_snapshot to see the page -> act on [ref=eN] handles -> browser_wait for the result. Only screenshot when you need to see pixels.

Token discipline — every tool call is a full model round-trip, so the number of calls is what makes a task slow, far more than what each call costs:
- Default to browser_batch whenever you can name the next two or more steps. navigate -> wait -> snapshot is ONE call, not three; the same steps repeated across a list of items is ONE call, not four per item. Refs from earlier steps are visible to later ones, and "parallel" fans the steps across tabs. Doing this by hand, one call at a time in a loop, is the single biggest waste there is — reach for browser_batch first, not as an afterthought.
- Re-reading a page inside a loop: use browser_snapshot mode:"diff", which returns only what changed since your last snapshot. Re-snapshotting the whole page every pass is what makes context, and therefore latency, grow without bound.
- browser_snapshot mode:"interactive" is the default first view of a page. Scope with the "selector" param on dense pages.
- Screenshots cost roughly 20x a snapshot. Use them to verify, not for routine navigation.

Fewer round-trips, per step:
- browser_act / browser_input take expect:{for, value} — the same conditions as browser_wait — and verify in the same call. "click Place order, expect text 'Order placed'" is one call, and a batch stops at a failed expectation, so it is a gate, not a note.
- browser_batch steps take when / unless (run only if a condition holds) and repeat ({until|while, max} or a count), and a step may hold sub-steps. "dismiss the cookie banner if there is one, then click Next until it disappears, then snapshot" is one call. Conditions are checked instantly, never waited for — put a browser_wait step before one that depends on a load.
- browser_batch async:true returns a job id at once; browser_wait for:"job" value:<id> collects it (or reports progress). Use it for a slow flow on one tab while you read another.
- browser_snapshot mode:"outline" is the cheap first look at a big page: landmarks and headings, each with its control count and a selector to scope by. A truncated snapshot ends with the same outline, so the next call scopes instead of paging.
- Every action already waits for the page to react (or to prove it will not) before returning; do not add browser_wait for:"time" after a click.

Stuck? Use your eyes. After two actions with no visible progress, take ONE browser_screenshot — overlays, modals, cookie banners, and canvas UIs may be invisible to snapshots. Then act on what you see with browser_act space:"image".

Reliability:
- browser_act uses real trusted input events, so it works where JS-dispatched clicks are rejected.
- After anything that triggers a load, browser_wait rather than assuming.
- If a ref is stale, re-snapshot; refs are invalidated when the DOM changes materially.

Clicking by sight: prefer a ref. When only a screenshot shows the target (canvas, maps, PDF, a game), read the pixel off the image and click it with browser_act coordinate:[imageX,imageY] space:"image" — the extension converts image pixels to the page for you, so you never do the scale math. Plain coordinate:[x,y] (no space) is viewport CSS pixels.

Who you are: one agent with a short name ("harbor"), shown on your tab group, on the pages you drive, and in every result. Your tabs live in a shared background "agent window" alongside other agents' tabs; the user's own windows are separate. A call with no tabId acts on your last-used tab, and opens one for you if you have none. browser_tabs action:"list" shows your tabs in full and everyone else as counts — other agents' tabs are never yours to use, and passing one of their tabIds is refused. To work on one of the user's pages, pass its tabId explicitly (see it with browser_tabs action:"list" windowId:<id>); it then becomes one of your tabs.

Parallelism: every tool takes a tabId. Open tabs with browser_tabs action:"new" (background by default) and fan work across them with the browser_batch "parallel" param. You never need a tab in the foreground to act on it — clicks, typing, navigation, snapshots and uploads all work on a background tab. browser_tabs action:"select" and browser_window focus only change which tab is showing inside the agent window; they never bring a window in front of the user, so there is no reason to call them while working.

Groups are optional — omit "group" for ordinary work. Pass it only to split your own tabs into named sub-groups (group:"invoices" vs group:"emails"); each becomes a coloured Chrome tab group titled "<you> · <group>". Two agents using the same group label never share tabs.

Trust the result, not the attempt. When an action reports "UNVERIFIED … dispatched", the input was sent but no page change was observed — the tab may be covered, or the control may do nothing on its own. Re-snapshot and confirm the expected state before continuing; do not blindly retry with force. A fully covered agent window drops trusted input silently, so hammering a click just repeats one that already landed or never will.`;
