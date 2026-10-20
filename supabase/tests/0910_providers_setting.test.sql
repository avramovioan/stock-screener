begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

select is((select value from app_settings where key = 'providers'), '{"yahoo_enabled": true}'::jsonb,
  'the provider kill switch row exists and defaults to enabled');
select is((select is_public from app_settings where key = 'providers'), false, 'the providers setting is not public');

set local role anon;
select is((select count(*)::int from app_settings where key = 'providers'), 0, 'anon cannot read the providers setting');
reset role;

set local role authenticated;
select throws_ok($$update app_settings set value = '{"yahoo_enabled": false}' where key = 'providers'$$, '42501', null,
  'a signed-in user cannot flip the kill switch');
reset role;

select * from finish();
rollback;
