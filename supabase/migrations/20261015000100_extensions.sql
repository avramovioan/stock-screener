-- P0 foundations: extensions and the private application schema.

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto with schema extensions;

-- Internal objects (SQL functions, job helpers) live in schema app; clients never reach it directly.
create schema if not exists app;
revoke all on schema app from public;
revoke all on schema app from anon, authenticated;
