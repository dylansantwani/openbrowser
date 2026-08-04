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
  description: 'Tab to act on. Omit for the active tab.',
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

export const TOOLS = [
  {
    name: 'browser_tabs',
    description:
      'List, open, close, select, or reload tabs. Every other tool takes a tabId, so many sites can be driven in parallel. Pass "group" to label a workstream — its tabs collect into a coloured Chrome tab group.',
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
          description: 'Workstream label. Tabs sharing a label group together. One label per parallel job.',
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
        windowId: { type: 'number', description: 'For "new": target window.' },
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
          enum: ['interactive', 'full', 'text', 'diff'],
          description:
            'interactive (default): controls + structure. full: adds static text. text: plain text, no refs. diff: only what changed since the last snapshot — use in loops.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector to scope the snapshot to one region. Big token saver on dense pages.',
        },
        maxChars: { type: 'number', description: 'Truncation budget. Default 20000.' },
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
      'Pointer and element actions. Dispatches real trusted input events, so it works on sites that ignore synthetic ones (Stripe, Google, banking, canvas). Auto-scrolls the target into view.',
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
            'dialog',
          ],
        },
        accept: {
          type: 'boolean',
          description: 'For "dialog": true = OK/Leave, false = Cancel/Stay.',
        },
        promptText: {
          type: 'string',
          description: 'For "dialog": text to type for prompt().',
        },
        ref: REF,
        coordinate: COORD,
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
      },
    },
  },

  {
    name: 'browser_screenshot',
    description:
      'Capture the page as an image. Expensive — prefer browser_snapshot. Use for visual verification, canvas/video/PDF, or when a snapshot does not explain what you see.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB,
        mode: {
          type: 'string',
          enum: ['viewport', 'full_page', 'element', 'region'],
          description: 'Default "viewport".',
        },
        ref: REF,
        region: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description: 'For "region": [x,y,width,height]. Also use to zoom into small detail.',
        },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Default jpeg (much smaller).' },
        quality: { type: 'number', description: 'jpeg only, 1-100. Default 70.' },
        maxWidth: { type: 'number', description: 'Downscale to this width. Default 1280.' },
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
          enum: ['text', 'no_text', 'selector', 'no_selector', 'ref_gone', 'url', 'network_idle', 'load', 'time'],
        },
        value: { type: 'string', description: 'The text, selector, ref, or URL substring/regex to wait for.' },
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
      'Run several tool calls as one request — a login flow becomes one call, not eight. Steps run in order; use "parallel" to fan them across tabs.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { ...TAB, description: 'Default tab for every step. A step may still set its own.' },
        steps: {
          type: 'array',
          description: 'Each step is {tool, args}. Refs from one step are visible to later steps.',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'Any browser_* tool name except browser_batch.' },
              args: { type: 'object' },
            },
            required: ['tool'],
          },
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
      'Resize, emulate a device, force light/dark, set zoom, or throttle the network.',
    inputSchema: {
      type: 'object',
      properties: {
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
        focus: { type: 'boolean', description: 'Bring the tab and its window to the front.' },
        state: {
          type: 'string',
          enum: ['normal', 'minimized', 'maximized', 'fullscreen'],
          description: 'Automation keeps running while minimized — use it to get the browser out of the way.',
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

Token discipline:
- browser_snapshot mode:"interactive" is the default view of a page. mode:"diff" in loops.
- Scope with the "selector" param on dense pages.
- Batch multi-step flows with browser_batch instead of one call per step.
- Screenshots cost roughly 20x a snapshot. Use them to verify, not to navigate.

Reliability:
- browser_act uses real trusted input events, so it works where JS-dispatched clicks are rejected.
- After anything that triggers a load, browser_wait rather than assuming.
- If a ref is stale, re-snapshot; refs are invalidated when the DOM changes materially.

Parallelism: every tool takes a tabId. Open tabs with browser_tabs action:"new" (background by default) and fan work across them with the browser_batch "parallel" param.

Label your work: pass group:"<short task name>" on every call. Tabs sharing a label collect into one Chrome tab group, and a session only drives tabs in its own group — so one label per task keeps concurrent jobs from reaching into each other, and makes the tab strip say what is running. If you are working on several unrelated things at once, give each its own label.`;
