begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

select is(app.consume_quota('t', 'r', 1, 'day', 2), true, 'first consume is allowed');
select is(app.consume_quota('t', 'r', 1, 'day', 2), true, 'second consume reaches the limit');
select is(app.consume_quota('t', 'r', 1, 'day', 2), false, 'limit reached returns false');
select is(
  (select used from public.ai_quota_usage where provider = 't' and resource = 'r' and period_kind = 'day'),
  2,
  'a denied call does not increment the counter'
);
select is(app.consume_quota('t', 'big', 3, 'day', 2), false, 'an amount larger than the limit is denied');
select is(
  (select used from public.ai_quota_usage where provider = 't' and resource = 'big'),
  0,
  'a denied first call leaves used at 0'
);
select is(app.consume_quota('t', 'm', 5, 'month', 10), true, 'month counters work');
select is(
  (select period_start from public.ai_quota_usage where provider = 't' and resource = 'm'),
  date_trunc('month', now() at time zone 'utc')::date,
  'a month counter starts on the first day of the UTC month'
);
select throws_ok(
  $$select app.consume_quota('t', 'x', 1, 'week', 5)$$,
  'P0001',
  null,
  'an unknown period kind is rejected'
);

select * from finish();
rollback;
