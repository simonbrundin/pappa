-- ============================================================================
-- Kandidatflöde - Utökning (Update)
-- ============================================================================

-- Vi lägger till fält för att hantera kandidater som inte är aktuella just nu,
-- men som har potential att komma tillbaka vid ett senare datum.

alter table person add column if not exists is_potential boolean not null default true;
alter table person add column if not exists not_relevant_reason text;
alter table person add column if not exists potential_review_at date;

comment on column person.is_potential is 'Indikerar om kandidaten ingår i de aktiva rekryteringsflödena (Potentiella) eller är parkerad (Icke aktuella).';
comment on column person.not_relevant_reason is 'Skäl till varför kandidaten inte är aktuell just nu.';
comment on column person.potential_review_at is 'Datum då kandidaten bör ses över igen för en ny genomgång.';
