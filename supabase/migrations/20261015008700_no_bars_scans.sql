-- No-bars streak (hosted fix 2026-10-19): a listing the universe sweep returns but Yahoo serves no price bars for (ACALG.PA) failed
-- fetch_bars and compute every day, which made every scan run end partial.
-- Forward-only and replay-safe (add column if not exists). Safe on top of existing rows: every listing starts at 0.
--
-- securities.no_bars_scans counts consecutive scans whose price fetch returned no bars. fetch_bars increments it on a failed fetch and
-- resets it on a successful one; compute writes the result as skipped (no_price_data) once it reaches 3. missing_scans cannot serve:
-- app.apply_quote_rows resets it to 0 for every symbol the sweep returns, so fetch failures never accumulate there.

alter table public.securities add column if not exists no_bars_scans int not null default 0;

comment on column public.securities.no_bars_scans is
  'Consecutive scans whose price fetch returned no bars; reset on a successful fetch. Unlike missing_scans it is not touched by the universe sweep.';
