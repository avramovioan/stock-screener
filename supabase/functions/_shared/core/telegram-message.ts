// The Telegram message of the public "new companies on the list" digest. Pure: no I/O, no clocks.

import type { DiscountEntry } from "./digest.ts";

/** Telegram refuses a message of 4,096 characters or more. */
export const TELEGRAM_MAX_CHARS = 4096;
const MAX_LINES = 20;
const MAX_NAME_CHARS = 80;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Telegram HTML needs only these three escaped in text; quotes too inside an attribute. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dayLabel(scanDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(scanDate);
  const month = m === null ? undefined : MONTHS[Number(m[2]) - 1];
  return m === null || month === undefined ? scanDate : `${Number(m[3])} ${month}`;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function companyLine(e: DiscountEntry): string {
  const ticker = escapeHtml(e.ticker ?? e.yahooSymbol);
  const name = escapeHtml(clip(e.name, MAX_NAME_CHARS));
  return `• <b>${ticker}</b> ${name} · #${e.rank} · at its −${e.line === "-4" ? 4 : 3} line`;
}

/**
 * HTML for Telegram's sendMessage (parse_mode HTML): the scan day, one line per company (at most 20, then "…and N more") and the
 * link. Whole lines are dropped, never cut, so the markup stays valid and the text stays under the Telegram limit.
 */
export function telegramDigestMessage(
  items: readonly DiscountEntry[],
  scanDate: string,
  siteUrl: string,
): string {
  const head = `<b>New on the screener · ${dayLabel(scanDate)}</b>`;
  const link = `<a href="${escapeHtml(siteUrl).replace(/"/g, "&quot;")}">Open the screener</a>`;
  const lines = items.slice(0, MAX_LINES).map(companyLine);
  const build = (shown: number): string => {
    const hidden = items.length - shown;
    const body = [head, ...lines.slice(0, shown), ...(hidden > 0 ? [`…and ${hidden} more`] : [])];
    return `${body.join("\n")}\n\n${link}`;
  };
  let shown = lines.length;
  while (shown > 0 && build(shown).length >= TELEGRAM_MAX_CHARS) shown--;
  return build(shown);
}
