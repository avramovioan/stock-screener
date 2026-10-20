# Trade position card and phone holdings — plan (2026-10-20)

Owner request: "when I click on Trade on IBKR button on any of the table rows I see a pop-up that shows many things but my
positions. So I can't see how many positions I have to enter. Can we also add that small card?" and "the positions table gets
converted to cards when on a phone screen. But with all the info buttons and so on - it looks very bad. Redesign the phone view."
Approved mockups ("Design looks great. Do it."): `.superpowers/sdd/2026-10-19-ui-mockups/project/TradePosition.dc.html` and
`PhoneHoldings.dc.html` (open them; texts and layout exactly as the boards, the notes column on each board is binding).

## Global Constraints

- TDD (RED then GREEN in the report). Touch only the files your task lists. No documentation edits.
- Load the `frontend-design` and `ui-ux-pro-max` skills before writing UI. shadcn primitives and Tailwind as in the surrounding code;
  lucide icons; touch targets 44 px on phones (`max-md:size-11` / `min-h-11`).
- Commits: conventional subject, body explains why, last line exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  stage only your files by name; never `docs/discovery/**` (unrelated modified files are in the tree: leave them).
- Commands: `bun run test:web`, `bunx biome ci <your files>` (0 errors), `bunx tsc -p apps/web --noEmit`. Never run db reset,
  test:db, integration or e2e (the lead does); update e2e specs/stubs under `apps/web/e2e/**` that assert changed texts.

### Task 1: "Your position" card in the Trade on IBKR dialog (web)

Files: `apps/web/src/features/handoff/types.ts`, `trade-on-ibkr-dialog.tsx` (+ test), new `handoff/position-card.tsx`
(+ test), `handoff/holding-target.ts` (+ test), `apps/web/src/features/portfolio/page/holding-extras.tsx` (+ test),
`positions-table.tsx` and `portfolio-page.tsx` only to thread the statement date (+ their tests if they break).

1. Type `HeldPosition` in `types.ts`: `{ quantity: number; averageCost: number | null; currency: string; marketValue: Money;
   unrealized: Money; heldSymbol: string; heldExchange: string | null; reportDate: string | null }` (`Money` from
   `@core/portfolio-view.ts`). Both `TradeTarget` and `HeldTarget` get an optional `position?: HeldPosition | undefined`.
   `holdingTarget` passes a `position` given in its input through to either target. Overview cards pass none: the dialog is
   unchanged there.
2. `TradeCell` builds the position from the row (`quantity`, `averageCost`, `currency`, `marketValue`, `unrealizedIndependent`)
   and the link's held line (symbol, listing exchange), plus the statement date: thread the portfolio's `reportDate` from
   `portfolio-page.tsx` through `PositionsTable` (new optional prop `reportDate`) to `TradeCell`.
3. `PositionCard` (rendered by the dialog right after the no-order notice, only when `target.position` is set):
   `section` with `aria-labelledby`, teal border and tint (`border-primary bg-accent/40` or the closest existing tokens; must
   read in dark mode), heading "Your position" (12 px uppercase, semibold), right of it "IBKR statement of <formatSessionDate(
   reportDate)>" (omit when null). A `dl` of four stats, `grid-cols-2 sm:grid-cols-4`: Shares (the quantity, en-GB, up to 6
   decimals, 22 px semibold), Avg cost (`formatAmount(averageCost) + " " + currency`, "unavailable" when null), Value
   (`MoneyText`), P&L (`MoneyText signed`, green/red tone as in the positions table). Numbers never wrap. Under it one line:
   "Held as <heldSymbol> on <label> (<code>), <currency>. Trades from today show up after tomorrow's statement." where label is
   Xetra for IBIS/IBIS2, Amsterdam for AEB, and for any other code just "on <code>"; no exchange → "Held as <symbol>, <ccy>.".
4. Order section, only with a position: when Side is Sell and quantity > 0, an outline button under the Quantity field
   "Use all <n> shares" ("share" when n is 1) that sets the quantity text to the held quantity. When Side is Sell and the
   parsed quantity is larger than the held quantity, a `role="status"` warning under the fields: "You hold <n> shares. Selling
   <q> would open a short position of <q − n>." (orange left border, as the board). It never blocks the prompt.
5. Tests: card present with the four figures and the held line for a held and for a screened target; absent for an Overview
   target; statement date line; phone grid class; Use-all button only on Sell and it fills the field; short warning appears
   above the held quantity and not at or below it; singular texts.

Commit: `feat(handoff): the trade dialog shows your position, with use-all and a short warning`.

### Task 2: phone holdings cards (web)

Files: `apps/web/src/features/portfolio/page/positions-table.tsx` (+ test), new `portfolio/page/phone-holding-card.tsx`
(+ test), `holding-extras.tsx` (+ test), `holding-actions.tsx` only for layout classes, `holdings-layout.test.tsx`,
e2e specs/stubs asserting the phone cards. The computer table (`md:` and up) must not change.

1. Phone card (`md:hidden` list) exactly as the PhoneHoldings board: no ⓘ button inside a card. Body: top row ticker
   (`text-xl font-semibold`) and on the right the valuation tag (`ValuationTag`; "Not screened" grey tag as today; inside the
   channel a grey `status-tag` "Within channel" instead of the dash); company name beneath on one truncated line (decoded);
   then "<qty> shares · <price> <ccy>" ("1 share"; no price → "<qty> shares · price unavailable"); then a two-column block with a
   top border: Value left, P&L right-aligned with today's change under it (same tones and "Does not reconcile" tag as the
   table). Actions row: Trade on IBKR filling the row (`flex-1 min-h-11`) and the re-evaluate and copy-prompt icon buttons
   beside it (44 px). Add a `layout?: "stack" | "row"` prop to `TradeCell` for this; default "stack" keeps the table.
2. A full-width disclosure button at the card bottom (border-top, `min-h-11`, primary colour, `aria-expanded`,
   `aria-controls`): "Details" with a chevron-down, "Hide details" with chevron-up when open. Open shows in place a `dl`
   (`grid-cols-[6rem_1fr]`, 13 px) with: Held as (symbol on <exchange>, ccy), ISIN (when known), Screened as / "Not a screened
   company", Avg cost, Cost basis (", broker-reported"), Price (the price source line now built in `RowFacts`), IBKR P&L (broker
   FIFO at the statement close, plus "reconciles"/"does not reconcile" when known), Valuation (`tagBasis`, when present), Note
   (price note, when present), Research (the `MonitoredHoldingBlock` and the "Open full report" link, monitored holdings only).
   Share the fact building with the ticker ⓘ and `RowFacts` (one helper, no copy-pasted blocks).
3. Sort row above the cards: "Sort" label, the select (same keys), a direction button: "High first"/"Low first" for numeric
   keys, "A to Z"/"Z to A" for ticker and valuation, with an arrow icon. On the right an `InfoBox` labelled
   "About these numbers" (44 px) holding the four column explanations (price, value, P&L, valuation) under short bold titles.
4. Tests: card content for a screened, an unscreened and an in-channel holding; no ⓘ buttons inside cards; Details toggling
   and the facts; sort direction labels; the About box; desktop table untouched (existing table tests still pass).

Commit: `feat(portfolio): phone holdings cards with a details row instead of info buttons`.
