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

export const INVITATION_ELIGIBILITY_CONTRACT = "invitation-eligibility-observations/v1";

export const INVITATION_ELIGIBILITY_CONTRACT_V2 = "invitation-eligibility-observations/v2";
export const INVITATION_ELIGIBILITY_CONTRACT_V3 = "invitation-eligibility-observations/v3";

// v3 carries an opaque source reason separately.  This public contract never
// interprets that text; source-specific correspondence remains in the Provider.
export function validateInvitationEligibilityObservationsV3(snapshot) {
  assertObject(snapshot, "invitation eligibility observations");
  if (snapshot.contractVersion !== INVITATION_ELIGIBILITY_CONTRACT_V3 || !Array.isArray(snapshot.creators)) {
    throw new TypeError("explicit invitation eligibility v3 contract and creators are required");
  }
  const v2 = { ...snapshot, contractVersion: INVITATION_ELIGIBILITY_CONTRACT_V2,
    creators: snapshot.creators.map((row) => {
      assertObject(row, "eligibility creator");
      for (const key of Object.keys(row)) if (!['accountKey','result','status','reason','complianceSignals','invitationCategory','externalUserId','nickname','avatar'].includes(key)) throw new TypeError(`unsupported eligibility creator field: ${key}`);
      if (typeof row.status !== 'string' || !row.status.trim()) throw new TypeError('observed status requires an explicit value');
      if (!(row.reason === null || (typeof row.reason === 'string' && row.reason.trim()))) throw new TypeError('reason must be null or nonempty text');
      if (row.status !== '対象外' && row.reason !== null) throw new TypeError('only ineligible status may carry a reason');
      if (row.complianceSignals !== undefined && (!Array.isArray(row.complianceSignals) || !row.complianceSignals.every(value => ['multiple_account_risk','other_agency_membership'].includes(value)) || new Set(row.complianceSignals).size !== row.complianceSignals.length)) throw new TypeError('invalid compliance signals');
      const { status, reason, complianceSignals, ...legacy } = row;
      return { ...legacy, eligibility: status };
    }) };
  validateInvitationEligibilityObservationsV2(v2);
  return snapshot;
}

// Deliberate opt-in: v1 remains unchanged and never silently discards category.
export function validateInvitationEligibilityObservationsV2(snapshot) {
  assertObject(snapshot, "invitation eligibility observations");
  if (snapshot.contractVersion !== INVITATION_ELIGIBILITY_CONTRACT_V2 || !Array.isArray(snapshot.creators)) {
    throw new TypeError("explicit invitation eligibility v2 contract and creators are required");
  }
  const creators = snapshot.creators.map((row) => {
    assertObject(row, "eligibility creator");
    if (!Object.hasOwn(row, "invitationCategory") || !(row.invitationCategory === null ||
        (typeof row.invitationCategory === "string" && row.invitationCategory.trim()))) {
      throw new TypeError("invitationCategory must be null or a nonempty string");
    }
    if (row.result !== "observed" && row.invitationCategory !== null) {
      throw new TypeError("unobserved invitationCategory must remain null");
    }
    const { invitationCategory, ...legacy } = row;
    return legacy;
  });
  validateInvitationEligibilityObservations({ ...snapshot, contractVersion: INVITATION_ELIGIBILITY_CONTRACT, creators });
  return snapshot;
}

// A new explicit semantic contract. Legacy state snapshots are never promoted
// into this contract by inference; the selected source must supply it.
export function validateInvitationEligibilityObservations(snapshot) {
  assertObject(snapshot, "invitation eligibility observations");
  if (snapshot.contractVersion !== INVITATION_ELIGIBILITY_CONTRACT) {
    throw new TypeError("explicit invitation eligibility contract is required");
  }
  for (const key of Object.keys(snapshot)) {
    if (!["contractVersion", "observedAt", "rowCount", "creators"].includes(key)) {
      throw new TypeError(`unsupported eligibility snapshot field: ${key}`);
    }
  }
  assertIsoDateTime(snapshot.observedAt, "eligibility observedAt");
  if (!Array.isArray(snapshot.creators) || snapshot.rowCount !== snapshot.creators.length) {
    throw new TypeError("eligibility rowCount must match creators.length");
  }
  const seen = new Set();
  for (const [index, row] of snapshot.creators.entries()) {
    assertObject(row, `eligibility creator ${index}`);
    for (const key of Object.keys(row)) {
      if (!["accountKey", "result", "eligibility", "externalUserId", "nickname", "avatar"].includes(key)) {
        throw new TypeError(`unsupported eligibility creator field: ${key}`);
      }
    }
    if (typeof row.accountKey !== "string") throw new TypeError("eligibility accountKey is required");
    const key = row.accountKey.normalize("NFKC").trim().replace(/^@/, "").toLocaleLowerCase("und");
    if (!key || seen.has(key)) throw new TypeError("eligibility accountKey is empty or duplicated after normalization");
    seen.add(key);
    if (!["observed", "not_found", "unavailable"].includes(row.result)) {
      throw new TypeError("eligibility result must be observed, not_found or unavailable");
    }
    if (row.result === "observed") {
      if (typeof row.eligibility !== "string" || !row.eligibility.trim()) {
        throw new TypeError("observed eligibility requires an explicit normalized value");
      }
    } else if (row.eligibility !== null) {
      throw new TypeError("not_found and unavailable eligibility must remain null");
    }
    // Reuse optional identity/avatar validation only; the placeholder stays
    // inside this structural check and is never returned or planned.
    validateInvitationObservations({ observedAt: snapshot.observedAt, rowCount: 1,
      creators: [{ accountKey: row.accountKey, state: "structural-validation", externalUserId: row.externalUserId,
        nickname: row.nickname, avatar: row.avatar }] });
  }
  return snapshot;
}
