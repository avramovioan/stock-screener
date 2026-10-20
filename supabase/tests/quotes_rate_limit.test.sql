begin;
create extension if not exists pgtap with schema extensions;
select plan(3);
select is(public.quotes_rl_incr('rl:quotes:test:1', now() + interval '2 minutes'), 1, 'first call returns 1');
select is(public.quotes_rl_incr('rl:quotes:test:1', now() + interval '2 minutes'), 2, 'second call returns 2');
select ok(
  not has_function_privilege('anon', 'public.quotes_rl_incr(text,timestamptz)', 'execute'),
  'anon cannot execute the counter'
);
select * from finish();
rollback;
