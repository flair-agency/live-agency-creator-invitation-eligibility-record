// Service-neutral validation owned by this business capability.
function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/;

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function assertIsoDateTime(value, label) {
  const match = typeof value === "string" ? value.match(ISO_DATE_TIME_PATTERN) : null;
  if (!match) {
    throw new TypeError(`${label} must be an ISO date-time string`);
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    zone,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = zone === "Z" ? 0 : Number(offsetHourText);
  const offsetMinute = zone === "Z" ? 0 : Number(offsetMinuteText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be an ISO date-time string`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}

export function validateInvitationObservations(snapshot) {
  assertObject(snapshot, "invitation observations");
  assertIsoDateTime(snapshot.observedAt, "invitation observations observedAt");
  if (!Array.isArray(snapshot.creators)) {
    throw new TypeError("invitation observations creators must be an array");
  }
  if (snapshot.rowCount !== snapshot.creators.length) {
    throw new TypeError("invitation observations rowCount must match creators.length");
  }

  const seen = new Set();
  for (const [index, creator] of snapshot.creators.entries()) {
    assertObject(creator, `invitation creator ${index}`);
    if (typeof creator.accountKey !== "string" || !creator.accountKey.trim()) {
      throw new TypeError(`invitation creator ${index} accountKey is required`);
    }
    if (seen.has(creator.accountKey)) {
      throw new TypeError(`invitation creator accountKey is duplicated: ${creator.accountKey}`);
    }
    seen.add(creator.accountKey);
    if (typeof creator.state !== "string" || !creator.state.trim()) {
      throw new TypeError(`invitation creator ${index} state is required`);
    }
    for (const key of ["externalUserId", "nickname"]) {
      if (creator[key] !== undefined && typeof creator[key] !== "string") {
        throw new TypeError(`invitation creator ${index} ${key} must be a string`);
      }
    }
    if (creator.avatar !== undefined && creator.avatar !== null) {
      assertObject(creator.avatar, `invitation creator ${index} avatar`);
      if (typeof creator.avatar.path !== "string" || !creator.avatar.path) {
        throw new TypeError(`invitation creator ${index} avatar.path is required`);
      }
      if (!/^[0-9a-f]{64}$/.test(creator.avatar.sha256 ?? "")) {
        throw new TypeError(`invitation creator ${index} avatar.sha256 is invalid`);
      }
      if (!Number.isSafeInteger(creator.avatar.size) || creator.avatar.size < 1) {
        throw new TypeError(`invitation creator ${index} avatar.size is invalid`);
      }
      if (typeof creator.avatar.name !== "string" || !creator.avatar.name) {
        throw new TypeError(`invitation creator ${index} avatar.name is required`);
      }
      if (typeof creator.avatar.mimeType !== "string" || !creator.avatar.mimeType.startsWith("image/")) {
        throw new TypeError(`invitation creator ${index} avatar.mimeType is invalid`);
      }
    }
  }
  return snapshot;
}

