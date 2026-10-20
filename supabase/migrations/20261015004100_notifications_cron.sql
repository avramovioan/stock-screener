-- Cut-off digests at 13:00 Europe/Sofia: 10:00 UTC in summer, 11:00 UTC in winter; app.cutoff_digests()
-- checks the Sofia hour = 13 (spec 7.1, 7.10). Idempotent by name (spec 6.10).
do $$
declare j text;
begin
  foreach j in array array['digest-cutoff-1000', 'digest-cutoff-1100'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;

select cron.schedule('digest-cutoff-1000', '0 10 * * *', 'select app.cutoff_digests();');
select cron.schedule('digest-cutoff-1100', '0 11 * * *', 'select app.cutoff_digests();');
