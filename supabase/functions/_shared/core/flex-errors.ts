// Flex Web Service error codes (spec 12.4, research flex 2.3) with their handling class and user-facing text.
// Pure data: shared by broker-sync (state machine) and the SPA (troubleshooting hints).

export type FlexErrorClass = "retry" | "fatal" | "expired";
export type ConnectionImpact = "error" | "expired" | null;

export interface FlexErrorInfo {
  code: number;
  ibkrText: string;
  cls: FlexErrorClass;
  /** Seconds to wait before the next attempt (retry class only). */
  retryAfterSeconds: number | null;
  /** A retry of this code consumes one poll of the budget (1018 does not). */
  countsAsPoll: boolean;
  connection: ConnectionImpact;
  message: string;
  hint: string;
}

const AUTO = "Nothing to do: the app retries automatically for up to 10 minutes.";

function entry(
  code: number,
  ibkrText: string,
  cls: FlexErrorClass,
  message: string,
  hint: string,
  o: { retryAfterSeconds?: number; countsAsPoll?: boolean; connection?: ConnectionImpact } = {},
): FlexErrorInfo {
  return {
    code,
    ibkrText,
    cls,
    retryAfterSeconds: cls === "retry" ? (o.retryAfterSeconds ?? 20) : null,
    countsAsPoll: cls === "retry" ? (o.countsAsPoll ?? true) : false,
    connection: o.connection ?? null,
    message,
    hint,
  };
}

const LIST: FlexErrorInfo[] = [
  entry(
    1001,
    "Statement could not be generated at this time. Please try again shortly.",
    "retry",
    "IBKR could not generate the statement yet.",
    AUTO,
  ),
  entry(
    1003,
    "Statement is not available.",
    "fatal",
    "IBKR has no statement for the requested dates.",
    "Press Sync now again tomorrow. If it persists, check the period of your Flex query and that the account is included.",
  ),
  entry(
    1004,
    "Statement is incomplete at this time. Please try again shortly.",
    "retry",
    "The statement is still being completed by IBKR.",
    AUTO,
  ),
  entry(
    1005,
    "Settlement data is not ready at this time. Please try again shortly.",
    "retry",
    "IBKR settlement data is not ready yet.",
    AUTO,
  ),
  entry(
    1006,
    "FIFO P/L data is not ready at this time. Please try again shortly.",
    "retry",
    "IBKR FIFO profit and loss data is not ready yet.",
    AUTO,
    { retryAfterSeconds: 30 },
  ),
  entry(
    1007,
    "MTM P/L data is not ready at this time. Please try again shortly.",
    "retry",
    "IBKR mark-to-market profit and loss data is not ready yet.",
    AUTO,
    { retryAfterSeconds: 30 },
  ),
  entry(
    1008,
    "MTM and FIFO P/L data is not ready at this time. Please try again shortly.",
    "retry",
    "IBKR profit and loss data is not ready yet.",
    AUTO,
    { retryAfterSeconds: 30 },
  ),
  entry(
    1009,
    "The server is under heavy load. Statement could not be generated at this time. Please try again shortly.",
    "retry",
    "The IBKR service is under heavy load.",
    AUTO,
    { retryAfterSeconds: 60 },
  ),
  entry(
    1010,
    "Legacy Flex Queries are no longer supported. Please convert over to Activity Flex.",
    "fatal",
    "The query is a legacy Flex Query.",
    "Create an Activity Flex Query (Client Portal, Reporting, Flex Queries, Activity Flex Query) and use its Query ID.",
    { connection: "error" },
  ),
  entry(
    1011,
    "Service account is inactive.",
    "fatal",
    "IBKR reports the Flex service account as inactive.",
    "Open Flex Web Service Configuration in the Client Portal and check that Flex Web Service Status is ticked; contact IBKR if it stays inactive.",
    { connection: "error" },
  ),
  entry(
    1012,
    "Token has expired.",
    "expired",
    "The Flex token has expired.",
    "Generate a new token in Client Portal, Flex Web Service Configuration, then link again with the new token.",
    { connection: "expired" },
  ),
  entry(
    1013,
    "IP restriction.",
    "fatal",
    "IBKR rejected the request because of the token's IP restriction.",
    "Remove the IP restriction from the token (this app calls Flex from changing Supabase addresses) or generate a new token without one.",
    { connection: "error" },
  ),
  entry(
    1014,
    "Query is invalid.",
    "fatal",
    "IBKR does not recognise the Query ID.",
    "Check the Query ID (the number shown at the top of the query's information panel) and that it is an Activity Flex Query.",
    { connection: "error" },
  ),
  entry(
    1015,
    "Token is invalid.",
    "fatal",
    "IBKR does not recognise the token.",
    "Copy the Current Token again from Flex Web Service Configuration and link again; a regenerated token invalidates the old one.",
    { connection: "error" },
  ),
  entry(
    1016,
    "Account in invalid.",
    "fatal",
    "IBKR reports a problem with the account.",
    "Check that the account in the Flex query is active and selected in the query's delivery configuration.",
    { connection: "error" },
  ),
  entry(
    1017,
    "Reference code is invalid.",
    "fatal",
    "IBKR no longer knows this statement request.",
    "The app starts one new request automatically; if it fails again press Sync now.",
  ),
  entry(
    1018,
    "Too many requests have been made from this token. Please try again shortly. Limited to one request per second, 10 requests per minute (per token).",
    "retry",
    "IBKR limits one token to 1 request per second and 10 per minute.",
    "The app waits a minute and tries again. Avoid using the same token in other tools at the same time.",
    { retryAfterSeconds: 60, countsAsPoll: false },
  ),
  entry(
    1019,
    "Statement generation in progress. Please try again shortly.",
    "retry",
    "IBKR is still generating the statement.",
    AUTO,
  ),
  entry(
    1020,
    "Invalid request or unable to validate request.",
    "fatal",
    "IBKR rejected the request.",
    "Check the Query ID and the token for typing errors; if both are right, report this error code to the operator.",
  ),
  entry(
    1021,
    "Statement could not be retrieved at this time. Please try again shortly.",
    "retry",
    "IBKR could not deliver the statement yet.",
    AUTO,
  ),
];

export const FLEX_ERRORS: Readonly<Record<number, FlexErrorInfo>> = Object.fromEntries(
  LIST.map((e) => [e.code, e]),
);

/** Codes below 1000 are produced by this app, never by IBKR. */
const INTERNAL: Readonly<Record<number, FlexErrorInfo>> = Object.fromEntries(
  [
    entry(0, "(transport)", "retry", "The IBKR Flex service could not be reached.", AUTO, {
      retryAfterSeconds: 30,
    }),
    entry(
      -1,
      "(parse)",
      "fatal",
      "The statement could not be read.",
      "Open the Flex query and check that the format is XML, the date format is yyyyMMdd and every required section and field of the setup list is selected.",
    ),
    entry(
      -2,
      "(key)",
      "fatal",
      "The stored token cannot be decrypted with the current server key.",
      "Link again: enter the token once more so it is stored under the current key.",
      { connection: "error" },
    ),
    entry(
      -3,
      "(account)",
      "fatal",
      "The statement belongs to a different account than the one linked.",
      "Unlink and link again if you switched accounts on purpose; otherwise check the Query ID.",
      { connection: "error" },
    ),
    entry(
      -4,
      "(poll limit)",
      "fatal",
      "IBKR did not deliver the statement within 10 minutes.",
      "Press Sync now later; large queries can take longer on busy days.",
    ),
    entry(
      -5,
      "(send limit)",
      "fatal",
      "IBKR kept refusing the statement request.",
      "Press Sync now later.",
    ),
    entry(
      -6,
      "(sections)",
      "fatal",
      "The statement is missing required sections or fields.",
      "Open the Flex query and select every section and field of the setup list, then press Test connection.",
      { connection: "error" },
    ),
    entry(
      -7,
      "(internal)",
      "fatal",
      "An internal error stopped the sync.",
      "Press Sync now again; if it repeats, report the time to the operator.",
    ),
  ].map((e) => [e.code, e]),
);

export const UNKNOWN_CODE_RETRIES = 2;

/** Poll budget: 10 polls, 15 s minimum spacing, 10 minutes in total (spec 12.4). */
export const POLL_DELAYS_S: readonly number[] = [15, 20, 30, 45, 60, 60, 90, 90, 100, 90];
export const MAX_POLLS = 10;
export const SEND_RETRY_LIMIT = 5;

export function flexErrorInfo(code: number): FlexErrorInfo {
  const known = FLEX_ERRORS[code] ?? INTERNAL[code];
  if (known !== undefined) return known;
  return entry(
    code,
    "(unknown)",
    "retry",
    `IBKR returned an unknown error code (${code}).`,
    "The app retries twice and then stops; report the code to the operator if it repeats.",
  );
}

/** Unknown codes are retryable twice, then fatal (`unknownAttempts` = how many unknown codes this run has seen before this one). */
export function classifyFlexCode(code: number, unknownAttempts: number): FlexErrorClass {
  const known = FLEX_ERRORS[code] ?? INTERNAL[code];
  if (known !== undefined) return known.cls;
  return unknownAttempts < UNKNOWN_CODE_RETRIES ? "retry" : "fatal";
}
