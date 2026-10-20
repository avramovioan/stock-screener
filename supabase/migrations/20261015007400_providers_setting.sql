-- P7: Yahoo kill switch (spec 15.5, mitigation 4). Not public; changed only through scan-control set_setting (audited).
insert into app_settings (key, value, is_public, description)
values ('providers', '{"yahoo_enabled": true}'::jsonb, false,
        'Provider kill switches (15.5). yahoo_enabled = false freezes every Yahoo request; the site keeps serving the last published data.')
on conflict (key) do nothing;
