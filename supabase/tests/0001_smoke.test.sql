begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

select has_extension('pg_cron', 'pg_cron is installed');
select has_extension('pg_net', 'pg_net is installed');
select has_extension('pgcrypto', 'pgcrypto is installed');
select has_extension('pgtap', 'pgtap is installed');

select has_schema('app', 'schema app exists');
select is(has_schema_privilege('public', 'app', 'usage'), false, 'PUBLIC cannot use schema app');
select is(has_schema_privilege('anon', 'app', 'usage'), false, 'anon cannot use schema app');
select is(has_schema_privilege('authenticated', 'app', 'usage'), false, 'authenticated cannot use schema app');

select * from finish();
rollback;
