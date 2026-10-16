// Routine heartbeats in a Chat: the divider a run leaves, the "(pass)" reply that makes it quiet, and how quiet runs
// fold away. Types: routines.d.mts.

const SUMMARY_LIMIT = 80;

export function isRoutineRun(message) {
  return message?.context?.kind === "routine-run";
}

/**
 * Whether a heartbeat reply is a pass: it starts with "(pass)" (leading whitespace, "*" and "_" ignored, any case), and the
 * rest of that line is the summary, at most 80 characters.
 */
export function parsePass(text) {
  const match = /^[\s*_]*\(pass\)(.*)/i.exec(String(text ?? ""));
  if (!match) return { quiet: false };
  const line = match[1]
    .split("\n")[0]
    .replace(/^[\s*_]+/, "")
    .trim();
  return { quiet: true, summary: line.slice(0, SUMMARY_LIMIT) };
}

function clock(at, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).formatToParts(at);
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
}

/** The divider as text: "Heartbeat · 10:15" when the run acted, "10:30 · quiet: CI green" when it passed. */
export function routineRunText(context, timeZone) {
  const time = clock(context.at, timeZone);
  if (!context.quiet) return `Heartbeat · ${time}`;
  return context.summary ? `${time} · quiet: ${context.summary}` : `${time} · quiet`;
}

const isQuietRun = (message) => isRoutineRun(message) && message.context.quiet === true;

/**
 * One entry per message, in order. A quiet run's reply is hidden. Quiet dividers with only their own replies between them
 * collapse into the last of them, which carries how many there were and its own context.
 */
export function groupQuietRuns(messages) {
  const entries = messages.map((message) => ({ message }));
  let run = [];
  const close = () => {
    if (run.length > 1) {
      for (const index of run.slice(0, -1)) entries[index].hidden = true;
      const last = run[run.length - 1];
      entries[last].merged = { count: run.length, last: messages[last].context };
    }
    run = [];
  };
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (isQuietRun(message)) {
      run.push(index);
      if (messages[index + 1]?.role === "assistant") {
        entries[index + 1].hidden = true;
        index += 1;
      }
    } else {
      close();
    }
  }
  close();
  return entries;
}
