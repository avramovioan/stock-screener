begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

select is((select schedule from cron.job where jobname = 'retention-cleanup'), '30 1 * * *', 'retention-cleanup is scheduled daily at 01:30 UTC');
select is((select count(*)::int from cron.job where jobname = 'retention-cleanup'), 1, 'exactly one retention-cleanup job');
select ok((select command from cron.job where jobname = 'retention-cleanup') like '%app.kick_retention_cleanup()%', 'job runs app.kick_retention_cleanup()');
select ok(pg_get_functiondef('app.kick_retention_cleanup()'::regprocedure) like '%/functions/v1/retention-cleanup%', 'function posts to the retention-cleanup path');

select * from finish();
rollback;
