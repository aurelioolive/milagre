const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SEARCH_LIMIT_MS = 366 * 24 * HOUR_MS;

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  // 7 is Sunday as well; it folds into 0 after parsing.
  { name: "dayOfWeek", min: 0, max: 7 },
];

function invalid(reason) {
  return new Error(`Invalid cron: ${reason}`);
}

function parseNumber(text, field) {
  if (!/^\d+$/.test(text)) throw invalid(`${field.name} has "${text}"`);
  const value = Number(text);
  if (value < field.min || value > field.max) {
    throw invalid(`${field.name} ${value} is outside ${field.min}-${field.max}`);
  }
  return value;
}

function parseField(text, field) {
  const values = new Set();
  for (const part of text.split(",")) {
    const [range, step, extra] = part.split("/");
    if (extra !== undefined || range === "") throw invalid(`${field.name} has "${part}"`);
    let stride = 1;
    if (step !== undefined) {
      if (!/^\d+$/.test(step) || Number(step) < 1) throw invalid(`${field.name} step "${step}"`);
      stride = Number(step);
    }
    let from;
    let to;
    if (range === "*") {
      from = field.min;
      to = field.max;
    } else if (range.includes("-")) {
      const [low, high, more] = range.split("-");
      if (more !== undefined) throw invalid(`${field.name} has "${part}"`);
      from = parseNumber(low, field);
      to = parseNumber(high, field);
      if (from > to) throw invalid(`${field.name} range "${range}" runs backwards`);
    } else {
      if (step !== undefined) throw invalid(`${field.name} step needs a range, got "${part}"`);
      from = to = parseNumber(range, field);
    }
    for (let value = from; value <= to; value += stride) values.add(value);
  }
  return values;
}

function parseCron(expr) {
  if (typeof expr !== "string") throw invalid("expected a string");
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) {
    throw invalid(`expected 5 fields, got ${expr.trim() === "" ? 0 : parts.length}`);
  }
  const cron = {};
  FIELDS.forEach((field, index) => {
    cron[field.name] = parseField(parts[index], field);
  });
  if (cron.dayOfWeek.delete(7)) cron.dayOfWeek.add(0);
  return cron;
}

function everyToCron(every) {
  const match = typeof every === "string" ? /^([1-9]\d*)([mh])$/.exec(every) : null;
  if (!match) throw new Error(`Invalid every: ${JSON.stringify(every)} (use e.g. 15m or 2h)`);
  let amount = Number(match[1]);
  let unit = match[2];
  if (unit === "m" && amount >= 60) {
    if (amount % 60 !== 0) {
      throw new Error(`Invalid every: ${every} (minutes above 59 must be whole hours)`);
    }
    amount /= 60;
    unit = "h";
  }
  if (unit === "m") return `*/${amount} * * * *`;
  if (amount === 24) return "0 0 * * *";
  if (amount > 24) throw new Error(`Invalid every: ${every} (at most 24h)`);
  return `0 */${amount} * * *`;
}

function wallClock(timeZone) {
  let format;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
  } catch {
    throw invalid(`unknown timezone ${timeZone}`);
  }
  return (epoch) => {
    const fields = {};
    for (const part of format.formatToParts(epoch)) {
      if (part.type !== "literal") fields[part.type] = Number(part.value);
    }
    const asUtc = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
    return {
      minute: fields.minute,
      hour: fields.hour,
      dayOfMonth: fields.day,
      month: fields.month,
      dayOfWeek: new Date(asUtc).getUTCDay(),
      // The wall clock read as if it were UTC: equal for two instants showing the same time.
      asUtc,
      offset: asUtc - Math.floor(epoch / MINUTE_MS) * MINUTE_MS,
    };
  };
}

function dayMatches(cron, wall) {
  if (!cron.month.has(wall.month)) return false;
  const dom = cron.dayOfMonth.has(wall.dayOfMonth);
  const dow = cron.dayOfWeek.has(wall.dayOfWeek);
  // Like Vixie cron: when both day fields are restricted, either one is enough.
  const domRestricted = cron.dayOfMonth.size < 31;
  const dowRestricted = cron.dayOfWeek.size < 7;
  return domRestricted && dowRestricted ? dom || dow : dom && dow;
}

function nextRun(expr, timeZone, after) {
  const cron = parseCron(expr);
  const read = wallClock(timeZone);
  const start = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = start + SEARCH_LIMIT_MS;
  for (let t = start; t <= limit;) {
    const wall = read(t);
    if (!dayMatches(cron, wall)) {
      // Jump toward local midnight, stopping an hour short so a 23 or 25 hour day can't skip past it.
      const toMidnight = 24 * 60 - (wall.hour * 60 + wall.minute);
      t += Math.max(1, toMidnight - 60) * MINUTE_MS;
      continue;
    }
    if (cron.hour.has(wall.hour) && cron.minute.has(wall.minute)) {
      // After clocks go back the same wall time shows twice; only the first one fires.
      const back = read(t - 3 * HOUR_MS).offset - wall.offset;
      const repeated = back > 0 && read(t - back).asUtc === wall.asUtc;
      if (!repeated) return t;
    }
    t += MINUTE_MS;
  }
  throw new Error("No run within a year");
}

module.exports = { everyToCron, nextRun, parseCron };
