-- Migration 20261015009000: a visitor-requested research report is stored with trigger 'visitor'.
-- The enum lacked the value, so every accepted visitor request failed with "invalid input value for enum research_trigger".
-- Forward-only and replay-safe (if not exists). Its own file: an added enum value cannot be used in the transaction that adds it.
alter type public.research_trigger add value if not exists 'visitor';
