/**
 * Tab grouping — making agent activity visible.
 *
 * When an agent is driving several tabs at once, a plain tab strip tells you
 * nothing: you cannot see which tabs it opened, which task each belongs to, or
 * which ones are safe to close. Chrome's tab groups solve exactly that, and
 * they cost nothing to maintain.
 *
 * Every session gets one group named after it — "harbor" — and a session that
 * splits its work with the `group` argument gets one group per sub-task, named
 * "harbor · research". The session's name is always the first word, so a strip
 * full of agents reads as a list of who is here, and "research" from two
 * different agents can never look like one job.
 */

/**
 * Colours cycle per group. Chrome offers eight; these are ordered to stay
 * distinguishable from each other and from the greys of ungrouped tabs.
 */
const COLORS = ['blue', 'purple', 'cyan', 'green', 'orange', 'pink', 'yellow', 'red'];

/** session/workstream scope -> {groupId, windowId, color} */
const groups = new Map();
let colorCursor = 0;

/**
 * Durable groupId -> {sessionId, workstream, client} ownership metadata.
 *
 * This map is the *only* thing that makes a Chrome tab group an agent group.
 * An earlier design marked agent groups with a lightning-bolt title prefix and found
 * them by that; the title is a display string a human can edit and a model can
 * imitate, and identity has no business living in it. Ownership is recorded
 * here when a group is made and read from here everywhere — the panel included,
 * which reads this same key from `chrome.storage.session`.
 */
const OWNERS_KEY = 'tabGroupOwnersV2';
let ownersQueue = Promise.resolve();

/** The workstream a session's plain tabs belong to: the session itself. */
const workstreamName = (sessionId, workstream) => workstream || sessionId || 'agent';
const scopeKey = (sessionId, workstream) => JSON.stringify([sessionId || null, workstreamName(sessionId, workstream)]);

/**
 * What the group is called on the tab strip.
 *
 * "harbor" for a session's ordinary tabs; "harbor · research" when the session
 * named a sub-group. Always the session first — it is the one word that appears
 * everywhere else (the on-page frame, the panel, every tool result), and the
 * strip has to agree with all of them.
 */
export function titleFor(sessionId, workstream) {
  const name = workstreamName(sessionId, workstream);
  if (!sessionId || name === sessionId) return name;
  return `${sessionId} · ${name}`;
}

async function readOwners() {
  try {
    return (await chrome.storage.session.get(OWNERS_KEY))[OWNERS_KEY] || {};
  } catch {
    return {};
  }
}

function mutateOwners(fn) {
  const run = ownersQueue.then(async () => {
    const owners = await readOwners();
    const result = fn(owners);
    await chrome.storage.session.set({ [OWNERS_KEY]: owners });
    return result;
  });
  ownersQueue = run.then(() => {}, () => {});
  return run;
}

const rememberOwner = (groupId, sessionId, workstream, client) =>
  mutateOwners((owners) => {
    const previous = owners[groupId] || {};
    owners[groupId] = {
      sessionId: sessionId || null,
      workstream: workstreamName(sessionId, workstream),
      // Which MCP client this session belongs to — display only. Kept if a
      // later call did not carry it, so the panel never loses the name it had.
      client: client || previous.client || null,
    };
  });

const forgetOwner = (groupId) =>
  mutateOwners((owners) => {
    delete owners[groupId];
  });

/** Chrome's sentinel for "not in a group". */
const NO_GROUP = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;

export function isSupported() {
  return typeof chrome.tabGroups !== 'undefined' && typeof chrome.tabs.group === 'function';
}

/**
 * Find a workstream's Chrome group, whether or not this service worker knows
 * about it.
 *
 * The `groups` map above is service-worker memory, and MV3 discards that every
 * ~30s idle — while the tab group itself survives. Trusting the map alone meant
 * a restarted worker believed a workstream had no group and created a *second*
 * one with the same title, splitting the workstream in two. Chrome is the
 * durable record; the map is only a cache in front of it.
 *
 * Matched on the durable owner record rather than the title, which is only
 * presentation.
 */
async function findGroups(sessionId, workstream, windowId) {
  const owners = await readOwners();
  const all = await chrome.tabGroups.query({});
  return all.filter((g) => {
    const owner = owners[g.id];
    return (
      owner?.sessionId === (sessionId || null) &&
      owner?.workstream === workstreamName(sessionId, workstream) &&
      (windowId == null || g.windowId === windowId)
    );
  });
}

/**
 * @param {string} sessionId server-stamped authority boundary
 * @param {string} workstream model-chosen display label
 * @param {number} [preferWindowId] when a workstream somehow has more than one
 *   group, take the one in this window. Duplicates should no longer be created
 *   — see `assign` — but they can still exist from an older run or be made by
 *   hand, and picking arbitrarily is how a session ends up acting in a window
 *   it never chose.
 */
async function findGroup(sessionId, workstream, preferWindowId) {
  const found = await findGroups(sessionId, workstream);
  if (preferWindowId != null) {
    const here = found.find((g) => g.windowId === preferWindowId);
    if (here) return here;
  }
  return found[0] || null;
}

/**
 * Put a tab into the named workstream group, creating the group if needed.
 *
 * Failures here are always swallowed by the caller: grouping is presentation.
 * A tab that could not be grouped still works perfectly, and breaking a
 * navigation because a cosmetic API misbehaved would be a bad trade.
 *
 * @param {number} tabId
 * @param {string} sessionId server-stamped authority boundary
 * @param {string} workstream display label, e.g. "checkout flow"
 * @param {string} [client] the MCP client's name, recorded for the panel
 *
 * One `assign` at a time per workstream.
 *
 * `assign` looks for the group, finds nothing, and creates one — across two
 * awaits. Two tabs being grouped into the same workstream at once therefore
 * both look, both miss, and both create, leaving *two* Chrome groups carrying
 * the same title. Nothing errors. But `findGroup` returns the first match, so
 * `tabsFor` from then on reports only half the workstream, and a session asking
 * "which tab am I working on" can be handed one from the wrong half — in the
 * wrong window, if the user has since dragged one group elsewhere.
 *
 * An agent opening several tabs in one batch does this to itself; several
 * agents make it routine. Serialising per name costs nothing — grouping is
 * already off the critical path — and removes the whole class.
 */
const assignQueues = new Map();

export function assign(tabId, sessionId, workstream, client) {
  const key = scopeKey(sessionId, workstream);
  const run = (assignQueues.get(key) || Promise.resolve()).then(() => assignNow(tabId, sessionId, workstream, client));
  assignQueues.set(key, run.then(() => {}, () => {}));
  return run;
}

async function assignNow(tabId, sessionId, workstream, client) {
  if (!isSupported()) return null;

  const key = scopeKey(sessionId, workstream);

  const tab = await chrome.tabs.get(tabId);

  // Fall back to Chrome when the in-memory cache is cold, or a restarted
  // service worker would create a duplicate group with the same title.
  let existing = groups.get(key);
  if (!existing) {
    const found = await findGroup(sessionId, workstream, tab.windowId).catch(() => null);
    if (found) existing = { groupId: found.id, windowId: found.windowId, color: found.color };
  }

  // Reuse the group only if it still exists and is in the same window —
  // chrome.tabs.group cannot move a tab across windows into a group.
  if (existing && existing.windowId === tab.windowId) {
    try {
      await chrome.tabGroups.get(existing.groupId);
      await chrome.tabs.group({ tabIds: [tabId], groupId: existing.groupId });
      groups.set(key, existing);
      if (client) await rememberOwner(existing.groupId, sessionId, workstream, client);
      return existing.groupId;
    } catch {
      groups.delete(key); // group was closed by the user; fall through
    }
  }

  // `createProperties.windowId` is not optional in practice, whatever the API
  // says. Without it a new group is created in the *current* window — Chrome's
  // last-focused one — and the tabs are **moved** there to join it. So grouping,
  // a purely cosmetic step whose failures are deliberately swallowed, silently
  // relocates the tab it was only supposed to colour.
  //
  // Invisible for as long as agents worked in the window that was already
  // current: the move was a no-op. The moment a session got a window of its own
  // it became total — every first tab of every workstream was dragged back into
  // the user's window, and the agent's own window, now empty, closed itself. The
  // session then reported no window bound, having been given one two calls ago.
  //
  // Read from `tab`, which was fetched above, so this is the window the tab is
  // actually in rather than the one anybody believes it is in.
  const groupId = await chrome.tabs.group({
    tabIds: [tabId],
    createProperties: { windowId: tab.windowId },
  });
  const color = COLORS[colorCursor++ % COLORS.length];

  await chrome.tabGroups.update(groupId, {
    title: titleFor(sessionId, workstream),
    color,
    // Left expanded: a collapsed group hides exactly the thing this feature
    // exists to show.
    collapsed: false,
  });

  await rememberOwner(groupId, sessionId, workstream, client);
  groups.set(key, { groupId, windowId: tab.windowId, color });
  return groupId;
}

/** Group several tabs into one workstream in a single call. */
export async function assignMany(tabIds, sessionId, workstream, client) {
  const ids = [];
  for (const tabId of tabIds) {
    try {
      await assign(tabId, sessionId, workstream, client);
      ids.push(tabId);
    } catch {
      /* cosmetic; keep going */
    }
  }
  return ids;
}

/**
 * Rename a workstream, e.g. to reflect progress ("checkout → order placed").
 * Cheap way for a long run to narrate itself in the tab strip.
 */
export async function rename(sessionId, workstream, title) {
  try {
    const key = scopeKey(sessionId, workstream);
    const entry = groups.get(key) || (await findGroup(sessionId, workstream).then((g) => g && { groupId: g.id }));
    if (!entry) return false;
    await chrome.tabGroups.update(entry.groupId, { title: titleFor(sessionId, title) });
    await rememberOwner(entry.groupId, sessionId, title);
    groups.delete(key);
    return true;
  } catch {
    return false;
  }
}

/** Ungroup a workstream's tabs, leaving the tabs themselves open. */
export async function release(sessionId, workstream) {
  const selected = workstream == null
    ? (await list()).filter((g) => g.sessionId === sessionId)
    : await findGroups(sessionId, workstream);
  if (workstream != null) groups.delete(scopeKey(sessionId, workstream));
  try {
    const found = workstream == null ? selected.map((g) => ({ id: g.groupId })) : selected;
    if (!found.length) return false;
    for (const group of found) {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id));
      await forgetOwner(group.id);
    }
    if (workstream == null) {
      for (const key of [...groups.keys()]) {
        try {
          if (JSON.parse(key)[0] === sessionId) groups.delete(key);
        } catch {
          /* old cache entry; harmless */
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Close every tab in a workstream. Used to clean up after a finished job. */
export async function closeWorkstream(sessionId, workstream) {
  groups.delete(scopeKey(sessionId, workstream));
  try {
    const ids = [];
    const found = await findGroups(sessionId, workstream);
    for (const group of found) {
      const tabs = await chrome.tabs.query({ groupId: group.id });
      ids.push(...tabs.map((t) => t.id));
    }
    if (!ids.length) return 0;
    await chrome.tabs.remove(ids);
    for (const group of found) await forgetOwner(group.id);
    return ids.length;
  } catch {
    return 0;
  }
}

/**
 * Current agent groups and their tabs, for browser_tabs list and the panel.
 *
 * A group is an agent's if — and only if — the owner record says so. Reading
 * the owner map rather than the `groups` cache matters for the same reason as
 * everywhere else here: after an MV3 restart the cache is empty while the
 * groups are still on screen, and a listing that silently omits them tells an
 * agent its own tabs do not exist.
 */
export async function list() {
  if (!isSupported()) return [];

  try {
    const out = [];
    const owners = await readOwners();
    for (const group of await chrome.tabGroups.query({})) {
      const owner = owners[group.id];
      if (!owner) continue; // someone else's group
      const tabs = await chrome.tabs.query({ groupId: group.id });
      out.push({
        name: owner.workstream,
        sessionId: owner.sessionId || null,
        client: owner.client || null,
        title: group.title,
        color: group.color,
        groupId: group.id,
        // Reported because a workstream can have a group in two windows, and a
        // listing that omits which is which is how a session concludes it is
        // working somewhere it is not.
        windowId: group.windowId,
        tabIds: tabs.map((t) => t.id),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * A workstream's tabs, most recently accessed first.
 *
 * Queried from Chrome rather than read out of the `groups` map above, because
 * that map is service-worker memory and does not survive an MV3 restart — while
 * the tab group itself does. Durable ownership metadata, not the visible title,
 * is the authority record: two sessions may use the same workstream label.
 *
 * @param {string|null} workstream one of the session's groups, or null for every
 *   tab the session has in any of them — which is what a call with no `group`
 *   means: "my tab", not "my tab in the group that happens to share my name".
 * @param {number} [windowId] restrict to this window. A workstream can end up
 *   with a group in each of two windows — the user drags a tab out, or the
 *   session was rebound with `browser_window use` after it had already opened
 *   tabs — and without this the *resolution* path can hand back a tab from the
 *   window the session is no longer working in. That is the wrong-window bug in
 *   its purest form: the session is told it is in the window it chose, and
 *   every subsequent call lands in the other one. Cleanup deliberately does not
 *   pass this, because releasing half a workstream is worse than releasing it
 *   all.
 */
export async function tabsFor(sessionId, workstream, windowId) {
  if (!isSupported() || !sessionId) return [];
  try {
    const all = [];
    const selected = workstream == null
      ? (await list()).filter((g) => g.sessionId === sessionId && (windowId == null || g.windowId === windowId))
      : await findGroups(sessionId, workstream, windowId);
    for (const group of selected) {
      all.push(...(await chrome.tabs.query({ groupId: group.id ?? group.groupId })));
    }
    return all
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
      .map((t) => t.id);
  } catch {
    return [];
  }
}

/**
 * Move a workstream's tabs into `windowId`, so its group follows the session.
 *
 * Rebinding a session to another window used to change only the bookkeeping:
 * new tabs went to the new window while the group — and every tab already in it
 * — stayed put, so a listing said "this workstream is in window A" about tabs
 * physically sitting in window B. Both halves were internally consistent and
 * they disagreed with each other, which is exactly the state an agent cannot
 * reason its way out of.
 *
 * Tabs are moved first and regrouped after, because `chrome.tabs.group` cannot
 * pull a tab across a window boundary into an existing group.
 *
 * @returns {number} how many tabs moved
 */
export async function moveTo(sessionId, windowId, workstream) {
  if (!isSupported() || !sessionId) return 0;
  let moved = 0;
  try {
    const selected = workstream == null
      ? (await list()).filter((g) => g.sessionId === sessionId)
      : await findGroups(sessionId, workstream);
    for (const group of selected) {
      if (group.windowId === windowId) continue;
      const groupId = group.id ?? group.groupId;
      const owner = (await readOwners())[groupId];
      const tabs = await chrome.tabs.query({ groupId });
      for (const tab of tabs) {
        try {
          // Ungrouped first: moving a tab that is still in a group takes the
          // whole group with it in some Chrome builds, which would drag another
          // session's tabs along if it shares the window.
          await chrome.tabs.ungroup([tab.id]);
          await chrome.tabs.move(tab.id, { windowId, index: -1 });
          await assign(tab.id, sessionId, owner?.workstream || workstream, owner?.client);
          moved++;
        } catch {
          /* a pinned or otherwise immovable tab is not worth failing the bind */
        }
      }
    }
  } catch {
    /* presentation; never fail the call that asked */
  }
  return moved;
}

/**
 * Which session and workstream own a tab, if any.
 *
 * Read from Chrome for the same reason as everything else here: the in-memory
 * map is gone after an MV3 restart, and a wrong "nobody owns this" is exactly
 * the answer that lets one session take over another's tab.
 */
export async function ownerFor(tabId) {
  if (!isSupported()) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId == null || tab.groupId === NO_GROUP) return null;
    await chrome.tabGroups.get(tab.groupId);
    return (await readOwners())[tab.groupId] || null;
  } catch {
    return null;
  }
}

/**
 * Owners of several tabs at once — one storage read, one groups query.
 *
 * For the batch forms of close/reload, which take a list of ids straight from a
 * model and used to act on all of them unchecked. `tabId -> owner|null`; a tab
 * that no longer exists is simply absent.
 */
export async function ownersFor(tabIds) {
  const out = new Map();
  if (!isSupported()) return out;
  const owners = await readOwners();
  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const grouped = tab.groupId != null && tab.groupId !== NO_GROUP;
      out.set(tabId, grouped ? owners[tab.groupId] || null : null);
    } catch {
      /* gone; the caller's own tabs.get will say so */
    }
  }
  return out;
}

export async function workstreamFor(tabId) {
  return (await ownerFor(tabId))?.workstream || null;
}

// A group the user closed or emptied should not linger in our map.
chrome.tabGroups?.onRemoved?.addListener((group) => {
  for (const [key, entry] of groups) {
    if (entry.groupId === group.id) groups.delete(key);
  }
  forgetOwner(group.id).catch(() => {});
});
