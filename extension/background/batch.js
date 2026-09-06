/**
 * Batch execution with control flow.
 *
 * A batch used to be a straight line: run these steps, in order, stop on the
 * first error. That made it useless the moment anything was uncertain — "click
 * Next until it disappears", "dismiss the banner if there is one", "open each
 * result" — and the model fell back to one round-trip per step, which is the
 * single most expensive shape a task can take. Every model turn costs seconds;
 * every step here costs milliseconds.
 *
 * So a step may carry:
 *
 *   when:   condition — run the step only if it holds right now
 *   unless: condition — run the step only if it does not
 *   repeat: { until?, while?, max? } — run the step (or its `steps`) again
 *           until `until` holds / while `while` holds, at most `max` times
 *   steps:  a sub-list, run as one unit under this step's when/unless/repeat
 *
 * Conditions are exactly browser_wait's vocabulary (`{for, value}`), evaluated
 * instantly against the step's tab. Nothing here is evaluated code: a model
 * gets loops and branches without the extension ever running a string it
 * wrote, which is the difference between a control-flow feature and an eval.
 *
 * Pure: the caller supplies `run` (dispatch one tool call) and `test` (answer
 * one condition), so the whole planner is unit-testable without Chrome.
 */

/**
 * Hard ceilings, so a repeat with a condition that never comes true cannot pin
 * the browser. The server-side batch timeout (300s) is the outer wall; these
 * make the failure explain itself long before that.
 */
export const MAX_REPEAT_DEFAULT = 10;
export const MAX_REPEAT = 50;
export const MAX_OPS = 500;
export const MAX_NESTING = 3;

/**
 * Run a step list.
 *
 * @param {Array} steps
 * @param {object} opts
 * @param {(tool: string, args: object) => Promise<{text?: string, images?: Array}>} opts.run
 * @param {(cond: {for: string, value?: string}, args: object) => Promise<boolean>} opts.test
 * @param {object} [opts.defaults] args merged under every step's own
 * @param {boolean} [opts.stopOnError=true]
 * @param {boolean} [opts.returnEach=false]
 * @param {(job: {i: number, tool: string}) => void} [opts.onStep] progress callback
 * @returns {Promise<{text: string, images?: Array}>}
 */
export async function runPlan(steps, opts) {
  const { run, test, defaults = {}, stopOnError = true, returnEach = false, onStep } = opts;
  if (!Array.isArray(steps) || !steps.length) throw new Error('batch needs at least one step');

  const outputs = [];
  const budget = { ops: 0 };

  /** Mark the last *real* tool step as final: only it pays for a page delta. */
  const finalIndex = returnEach ? -1 : lastToolIndex(steps);

  await runList(steps, { depth: 0, quietAll: false, finalIndex, path: '' });

  const images = outputs.flatMap((o) => o.images || []);

  if (returnEach) {
    return {
      text: outputs
        .map((o) => `[${o.label}] ${o.tool}${o.ok ? '' : ' FAILED'}${o.note ? ` ${o.note}` : ''}\n${o.text}`)
        .join('\n\n'),
      ...(images.length ? { images } : {}),
    };
  }

  // Default: the trail plus the final result. The intermediate steps are almost
  // never interesting once they succeeded, but knowing they ran — and how many
  // times, and which were skipped — is.
  const last = [...outputs].reverse().find((o) => o.ok && !o.skipped) || outputs[outputs.length - 1];
  return { text: `${trailOf(outputs)}\n\n${last?.text ?? ''}`, ...(images.length ? { images } : {}) };

  // ---------------------------------------------------------------------------

  async function runList(list, ctx) {
    for (const [i, step] of list.entries()) {
      const label = ctx.path ? `${ctx.path}.${i + 1}` : String(i + 1);
      await runStep(step, { ...ctx, label, isFinal: ctx.depth === 0 && i === ctx.finalIndex });
    }
  }

  async function runStep(step, ctx) {
    validateStep(step, ctx);
    const args = { ...defaults, ...(step.args || {}) };
    const isGroup = Array.isArray(step.steps);
    const tool = isGroup ? `group(${step.steps.length})` : step.tool;

    // Gate first. A skipped step is recorded so the trail says why nothing ran.
    if (step.when && !(await evaluate(step.when, args, 'when'))) {
      outputs.push({ label: ctx.label, tool, ok: true, skipped: true, text: '', note: `skipped: ${describe(step.when)} was false` });
      return;
    }
    if (step.unless && (await evaluate(step.unless, args, 'unless'))) {
      outputs.push({ label: ctx.label, tool, ok: true, skipped: true, text: '', note: `skipped: ${describe(step.unless)} was true` });
      return;
    }

    const repeat = normaliseRepeat(step.repeat);
    if (!repeat) {
      await runOnce(step, args, ctx, tool);
      return;
    }

    // A `while` that is already false runs zero times; an `until` runs at least
    // once, like do/while — the common shape is "click Next until it is gone",
    // and there is nothing to check before the first click.
    let runs = 0;
    let satisfied = !(repeat.until || repeat.while); // a bare count is never "exhausted"
    while (runs < repeat.max) {
      if (repeat.while && !(await evaluate(repeat.while, args, 'while'))) {
        satisfied = true;
        break;
      }
      await runOnce(step, args, { ...ctx, iteration: runs + 1 }, tool);
      runs++;
      if (repeat.until && (await evaluate(repeat.until, args, 'until'))) {
        satisfied = true;
        break;
      }
    }
    if (!satisfied) {
      const cond = describe(repeat.until || repeat.while);
      const msg = `repeat hit max ${repeat.max} with ${cond} still ${repeat.until ? 'false' : 'true'}`;
      const rec = { label: ctx.label, tool, ok: false, text: msg, note: `×${runs}` };
      outputs.push(rec);
      if (stopOnError) throw new Error(`step ${ctx.label} (${tool}) ${msg}\n\nsteps run:\n${trailOf(outputs)}`);
    }
  }

  async function runOnce(step, args, ctx, tool) {
    if (Array.isArray(step.steps)) {
      await runList(step.steps, { ...ctx, depth: ctx.depth + 1, path: ctx.label, isFinal: false });
      return;
    }
    // Only real tool calls count against the ceiling; a group is bookkeeping.
    if (++budget.ops > MAX_OPS) {
      throw new Error(`batch exceeded ${MAX_OPS} tool calls — a repeat is probably not terminating\n\nsteps run:\n${trailOf(outputs)}`);
    }

    // Only the final step pays for a page delta: intermediate results are
    // discarded unless `returnEach`, so building them was pure latency — up to
    // three seconds a step on a large app.
    const quiet = !returnEach && !ctx.isFinal;
    onStep?.({ i: budget.ops, tool: step.tool, label: ctx.label });

    try {
      const result = await run(step.tool, quiet ? { ...args, _quiet: true } : args);
      const prev = ctx.iteration > 1 ? outputs.findLast?.((o) => o.label === ctx.label && o.ok && !o.skipped) : null;
      if (prev) {
        // Collapse iterations into one trail entry; the last result wins.
        prev.text = result?.text ?? '';
        prev.images = result?.images;
        prev.runs = ctx.iteration;
      } else {
        outputs.push({ label: ctx.label, tool: step.tool, ok: true, text: result?.text ?? '', images: result?.images, runs: ctx.iteration || 1 });
      }
    } catch (err) {
      outputs.push({ label: ctx.label, tool: step.tool, ok: false, text: err.message, runs: ctx.iteration });
      if (stopOnError) {
        throw new Error(`step ${ctx.label} (${step.tool}) failed: ${err.message}\n\nsteps run:\n${trailOf(outputs)}`);
      }
    }
  }

  async function evaluate(cond, args, where) {
    if (!cond || typeof cond !== 'object' || !cond.for) {
      throw new Error(`${where} needs {for, value} — the same shape as browser_wait, e.g. {for:"text", value:"Next"}`);
    }
    return !!(await test(cond, args));
  }
}

function validateStep(step, ctx) {
  if (!step || typeof step !== 'object') throw new Error(`step ${ctx.label} is not an object`);
  const isGroup = Array.isArray(step.steps);
  if (!isGroup && !step.tool) throw new Error(`step ${ctx.label} needs a tool (or steps)`);
  if (isGroup && step.tool) throw new Error(`step ${ctx.label} has both tool and steps — a group has no tool of its own`);
  if (step.tool === 'browser_batch') throw new Error('batch cannot nest — flatten the inner steps into this one list (use a step with `steps` for a group)');
  if (isGroup && ctx.depth + 1 > MAX_NESTING) throw new Error(`step ${ctx.label}: groups nest at most ${MAX_NESTING} deep`);
  if (isGroup && !step.steps.length) throw new Error(`step ${ctx.label}: an empty group does nothing`);
}

function normaliseRepeat(repeat) {
  if (!repeat) return null;
  if (typeof repeat === 'number') return { max: clampMax(repeat) };
  if (typeof repeat !== 'object') throw new Error('repeat must be a number or {until, while, max}');
  if (!repeat.until && !repeat.while && repeat.max == null) {
    throw new Error('repeat needs until, while, or max — {max: 3} runs three times, {until: {for:"no_selector", value:".next"}} runs until the condition holds');
  }
  return { until: repeat.until, while: repeat.while, max: clampMax(repeat.max ?? MAX_REPEAT_DEFAULT) };
}

function clampMax(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) throw new Error('repeat max must be a positive integer');
  return Math.min(v, MAX_REPEAT);
}

/** Index of the last top-level step that is a plain tool call (not a group). */
function lastToolIndex(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.tool && !Array.isArray(steps[i]?.steps)) return i;
  }
  return -1;
}

function describe(cond) {
  if (!cond) return '(none)';
  return cond.value != null ? `${cond.for} ${JSON.stringify(String(cond.value))}` : cond.for;
}

/** `✓ browser_navigate → ✓ browser_act ×4 → – browser_act (skipped) → ✗ browser_wait` */
export function trailOf(outputs) {
  return outputs
    .map((o) => {
      if (o.skipped) return `– ${o.tool} (${o.note})`;
      const times = o.runs > 1 ? ` ×${o.runs}` : '';
      return `${o.ok ? '✓' : '✗'} ${o.tool}${times}${o.ok ? '' : `: ${o.text}`}`;
    })
    .join(' → ');
}
