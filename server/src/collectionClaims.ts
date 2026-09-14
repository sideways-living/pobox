const defaultTimeZone = "Australia/Melbourne";

function partsAt(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, Number(part.value)])) as Record<string, number>;
}

function zonedDate(year: number, month: number, day: number, hour: number, timeZone: string) {
  const targetWallTime = Date.UTC(year, month - 1, day, hour, 0, 0);
  let guess = targetWallTime;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = partsAt(new Date(guess), timeZone);
    const actualWallTime = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += targetWallTime - actualWallTime;
  }
  return new Date(guess);
}

export function collectionClaimExpiresAt(now = new Date(), timeZone = process.env.POBOX_TIME_ZONE || defaultTimeZone) {
  const local = partsAt(now, timeZone);
  const target = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return zonedDate(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), 3, timeZone);
}
