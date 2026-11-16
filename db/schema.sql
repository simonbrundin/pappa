-- ============================================================================
-- pappa - Masterdatabas för IT-rekrytering i Sundsvall
-- PostgreSQL 16+
--
-- Designprinciper
--   1. Proveniens: varje person har minst en källa. Utan källa -> inte i DB.
--   2. Historik: positioner ändras. person_employment håller historik så att
--      "var på den här personen?" går att svara på utan att gissa.
--   3. GDPR byggs in: rättslig grund, retention_until, do_not_contact,
--      kontaktlogg och raderingsbegäran är datamodellens första klass.
--   4. Dubblettkoll: fuzzy match på namn + organisation (pg_trgm).
--   5. Bevakningslista: watchlist_entry = er Teams-lista, med ägare och status.
--
-- Kör:  psql "$DATABASE_URL" -f db/schema.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tillägg
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;    -- gen_random_uuid()
create extension if not exists pg_trgm;     -- fuzzy match / dedupe
create extension if not exists fuzzystrmatch; -- levenshtein for namnmatchning
create extension if not exists unaccent;    -- "Sundsvalls kommun" = "Sundsvalls Kommun"

-- ---------------------------------------------------------------------------
-- Typer
-- ---------------------------------------------------------------------------
do $$ begin
  create type org_kind      as enum ('consultancy','public_sector','industry','academia','vendor','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type confidence    as enum ('high','medium','low');
exception when duplicate_object then null; end $$;

do $$ begin
  create type source_kind   as enum ('company_site','conference','community','public_record',
                                     'press','profile','register','manual','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type contact_state as enum ('lead','verified','contacted','in_process','hired',
                                     'rejected','not_relevant','do_not_contact');
exception when duplicate_object then null; end $$;

do $$ begin
  create type contact_channel as enum ('email','phone','linkedin','teams','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type contact_outcome as enum ('sent','delivered','replied','no_reply','bounced',
                                       'opted_out','interested','not_interested','wrong_person');
exception when duplicate_object then null; end $$;

do $$ begin
  create type dsr_kind       as enum ('access','erasure','rectification','objection','restriction');
exception when duplicate_object then null; end $$;

do $$ begin
  create type dsr_state      as enum ('open','in_progress','completed','refused');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Organisation (arbetsgivare)
-- ---------------------------------------------------------------------------
create table if not exists organization (
  id              uuid primary key default gen_random_uuid(),
  name            text        not null,
  normalized_name text        not null,
  aliases         text[]      not null default '{}',
  kind            org_kind,
  website         text,
  linkedin_org    text,                        -- vanity-namn eller urn
  city            text,
  employees       int,                         -- senast kända, ej SCB-verifierat
  employee_source text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint organization_name_unique unique (normalized_name)
);

create index if not exists organization_name_trgm
  on organization using gin (normalized_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Person
-- ---------------------------------------------------------------------------
create table if not exists person (
  id                  uuid primary key default gen_random_uuid(),
  external_id         text,                    -- id:t i YAML / annat källsystem
  full_name           text        not null,
  normalized_name     text        not null,
  given_name          text,
  family_name         text,
  title               text,
  seniority           text check (seniority in
                        ('cxo','chef','lead','senior','mid','junior','unknown')),
  organization_id     uuid references organization(id) on delete set null,
  location            text,
  location_confidence confidence not null default 'low',
  data_confidence     confidence not null default 'low',
  linkedin_urn        text,
  linkedin_slug       text,
  email               text,
  phone               text,
  contact_published   boolean not null default false,  -- publicerad av arbetsgivaren
  lawful_basis        text        not null default 'legitimate_interests',
  legal_basis_note    text,
  -- Minsta antal år i IT. Null = okänt (visas aldrig som "3+ år").
  -- it_experience_basis säger var värdet kommer ifrån:
  --   'explicit'   - angivet i YAML
  --   'documented' - summan av daterad anställningshistorik
  --   'notes'      - utvuxet ur notes-texten
  --   'seniority'  - undre gräns utifrån rollnivå (seniority)
  it_experience_years  int,
  it_experience_basis  text,
  -- Rekrytering: när personen kan börja (null = okänt)
  available_from  date,
  -- Talade språk (fritext, t.ex. {svenska, engelska})
  spoken_languages text[] not null default '{}'::text[],
  contact_state       contact_state not null default 'lead',
  do_not_contact      boolean     not null default false,
  retention_until     date,                    -- GDPR: gallras detta datum
  notes               text,
  extra               jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Befintliga databaser
--
-- 'create table if not exists' ändrar inte en tabell som redan finns, så
-- kolumnerna ovan läggs till separat. Alla statements är idempotenta och
-- måste stå FÖRE indexen på it_experience_years.
-- ---------------------------------------------------------------------------
alter table person add column if not exists it_experience_years int;
alter table person add column if not exists it_experience_basis text;
alter table person add column if not exists available_from date;
alter table person add column if not exists spoken_languages text[] not null default '{}'::text[];

alter table person drop constraint if exists person_it_experience_basis_check;
do $$ begin
  alter table person add constraint person_it_experience_basis_check
    check (it_experience_basis is null or
           it_experience_basis in ('explicit','documented','notes','seniority'));
exception when duplicate_object then null; end $$;

create index if not exists person_name_trgm      on person using gin (normalized_name gin_trgm_ops);
create index if not exists person_org            on person (organization_id);
create index if not exists person_state          on person (contact_state);
create index if not exists person_retention      on person (retention_until);
create index if not exists person_linkedin_urn   on person (linkedin_urn);
create index if not exists person_it_experience   on person (it_experience_years);
create unique index if not exists person_external_id_uniq
  on person (external_id) where external_id is not null;

-- ---------------------------------------------------------------------------
-- Anställningshistorik (positioner flyttar)
-- ---------------------------------------------------------------------------
create table if not exists person_employment (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references person(id) on delete cascade,
  organization_id uuid references organization(id) on delete set null,
  title           text,
  is_current      boolean not null default true,
  valid_from      date,
  valid_to        date,
  source_id       uuid,
  note            text,
  created_at      timestamptz not null default now()
);
create index if not exists employment_person  on person_employment (person_id);
create index if not exists employment_current on person_employment (organization_id) where is_current;

-- ---------------------------------------------------------------------------
-- Anställningshistorik - CV-format
--
-- En rad = en tjänst, som på ett CV: var, vad, hur länge.
--   valid_from/valid_to = månadprecision. Båda NULL = perioden är helt okänd.
--   valid_to NULL + is_current = false  -> "slutdatum okänt" (inte "pågående")
--   is_current = true                    -> pågående tjänst
--   ref = idempotent nyckel mot YAML-filen, så importen kan uppdatera i stället
--         för att duplicera.
--   confidence = hur väl dokumenterad raden är ('high' = belagd av källa,
--         'medium' = utläst ur fritext, 'low' = hypotes).
-- ---------------------------------------------------------------------------
alter table person_employment
  add column if not exists ref text,
  add column if not exists employment_type text,
  add column if not exists seniority text,
  add column if not exists confidence confidence not null default 'low',
  add column if not exists stack text[] not null default '{}'::text[];

do $$ begin
  alter table person_employment add constraint person_employment_type_check
    check (employment_type is null or employment_type in
           ('employment','freelance','consultant','project','education'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table person_employment add constraint person_employment_seniority_check
    check (seniority is null or seniority in
           ('cxo','chef','lead','senior','mid','junior','unknown'));
exception when duplicate_object then null; end $$;

create unique index if not exists employment_person_ref_uniq
  on person_employment (person_id, ref) where ref is not null;

-- (employment_competence skapas nedan, efter competence - FK kräver tabellen)

-- ---------------------------------------------------------------------------
-- Kompetens (normaliserade taggar + ordbok)
-- ---------------------------------------------------------------------------
create table if not exists competence (
  id          serial primary key,
  tag         text unique not null,
  category    text,          -- language, platform, method, domain, leadership
  description text
);

create table if not exists person_competence (
  person_id      uuid not null references person(id) on delete cascade,
  competence_id  int not null references competence(id) on delete cascade,
  level          text,        -- 'expert','advanced','basic', null = okänd
  source_id      uuid,
  primary key (person_id, competence_id)
);

-- Teknik per tjänst (t.ex. "vilken stack på CGI?"). Skapas här eftersom
-- competence-tabellen måste finnas först.
create table if not exists employment_competence (
  employment_id uuid not null references person_employment(id) on delete cascade,
  competence_id int  not null references competence(id) on delete cascade,
  primary key (employment_id, competence_id)
);
create index if not exists employment_competence_comp on employment_competence (competence_id);

-- ---------------------------------------------------------------------------
-- Källor och koppling person-källa
-- ---------------------------------------------------------------------------
create table if not exists source (
  id          uuid primary key default gen_random_uuid(),
  url         text        not null,
  title       text,
  kind        source_kind not null default 'other',
  publisher   text,
  accessed_at date        not null default current_date,
  note        text,
  created_at  timestamptz not null default now()
);
create unique index if not exists source_url_unique on source (url);

-- Källa på anställningsraden: FK till source (tabellen finns nu).
do $$ begin
  alter table person_employment
    add constraint person_employment_source_fk
    foreign key (source_id) references source(id) on delete set null;
exception when duplicate_object then null; end $$;

create table if not exists person_source (
  person_id   uuid not null references person(id) on delete cascade,
  source_id   uuid not null references source(id) on delete cascade,
  retrieved_at timestamptz not null default now(),
  quote       text,
  primary key (person_id, source_id)
);

-- ---------------------------------------------------------------------------
-- Dubbletter: sammanslagning av två poster om samma person
--
-- När två poster slås ihop raderas den ena. Men frölistan (YAML) kan ju
-- fortfarande innehålla båda - nästa import skulle då skapa den raderade
-- posten igen. Därför registreras den raderade postens external_id här, och
-- importen hoppar över den. Det gör sammanslagningen beständig.
-- ---------------------------------------------------------------------------
create table if not exists person_merge (
  id                  uuid primary key default gen_random_uuid(),
  dropped_external_id text unique not null,  -- external_id som togs bort
  dropped_name        text,
  dropped_detail      jsonb not null default '{}'::jsonb,
  keep_person_id      uuid references person(id) on delete cascade,
  keep_external_id    text,
  actor               text,
  merged_at           timestamptz not null default now(),
  note                text
);

-- ---------------------------------------------------------------------------
-- Bevakningslista (er Teams-lista) + ägare
-- ---------------------------------------------------------------------------
create table if not exists watchlist (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  owner_email text,
  created_at  timestamptz not null default now()
);

create table if not exists watchlist_entry (
  id             uuid primary key default gen_random_uuid(),
  watchlist_id   uuid not null references watchlist(id) on delete cascade,
  person_id      uuid not null references person(id) on delete cascade,
  owner_email    text,
  state          contact_state not null default 'lead',
  added_at       timestamptz not null default now(),
  last_contacted timestamptz,
  next_action    text,
  note           text,
  unique (watchlist_id, person_id)
);

-- ---------------------------------------------------------------------------
-- Kontaktlogg (bevisar Art. 14-information skickad, och "avsaknad av kontakt")
-- ---------------------------------------------------------------------------
create table if not exists contact_event (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references person(id) on delete cascade,
  watchlist_entry_id uuid references watchlist_entry(id) on delete set null,
  channel       contact_channel not null,
  outcome       contact_outcome,
  occurred_at   timestamptz not null default now(),
  art14_sent    boolean not null default false,
  art14_sent_at timestamptz,
  operator      text,
  note          text
);
create index if not exists contact_event_person on contact_event (person_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Raderings-/insynsbegäran (GDPR Art. 15-21) - loggas även efter radering
-- ---------------------------------------------------------------------------
create table if not exists dsr_request (
  id          uuid primary key default gen_random_uuid(),
  kind        dsr_kind not null,
  subject_ref text,           -- namn/URN som begäran avser (lagras, ej fullständig profil)
  state       dsr_state not null default 'open',
  received_at timestamptz not null default now(),
  due_at      date not null default (current_date + 30),
  handled_at  timestamptz,
  handled_by  text,
  note        text
);

-- ---------------------------------------------------------------------------
-- Import-/provenance-spår
-- ---------------------------------------------------------------------------
create table if not exists import_run (
  id           uuid primary key default gen_random_uuid(),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  source_file  text,
  source_sha   text,
  persons_in   int,
  persons_new  int,
  persons_upd  int,
  note         text
);

create table if not exists audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor      text,
  action     text not null,
  table_name text,
  row_id     text,
  detail     jsonb
);

-- ---------------------------------------------------------------------------
-- Hjälpfunktioner
-- ---------------------------------------------------------------------------

-- Normalisering: gemener, avstrippa accenter, kollapsa whitespace
create or replace function fn_normalize(text)
returns text
language sql
immutable
as $$
  select regexp_replace(lower(unaccent(coalesce($1,''))), '\s+', ' ', 'g');
$$;

-- Dubblettkoll: fuzzy match på namn inom en organisation + liknande organisationsnamn
create or replace function fn_find_duplicates(
  p_name text,
  p_org  text default null,
  p_threshold real default 0.72
)
returns table (
  person_id      uuid,
  full_name      text,
  organization   text,
  similarity     real,
  same_org       boolean
)
language sql
stable
as $$
  select p.id,
         p.full_name,
         o.name,
         similarity(p.normalized_name, fn_normalize(p_name))::real as sim,
         (p_org is not null and o.normalized_name = fn_normalize(p_org)) as same_org
  from person p
  left join organization o on o.id = p.organization_id
  where similarity(p.normalized_name, fn_normalize(p_name)) >= p_threshold
     or (p_org is not null and o.normalized_name = fn_normalize(p_org)
         and similarity(p.normalized_name, fn_normalize(p_name)) >= 0.55)
  order by sim desc;
$$;

-- Namnmatchning: delar upp namnet i förnamn och efternamn och jämför
-- delarna var för sig.
--
-- fn_part_match ger fyra utfall per ord:
--   exact  (1.00) - identiska
--   prefix (0.90) - den ena är prefix av den andra ("lind"/"lindqvist").
--                   Kräver minst 4 tecken i den kortare delen, annars
--                   skulle "per" matcha "petra".
--   near   (0.75) - 1-3 tecken fel ("anders"/"andreas", "jonatan"/"jonathan").
--                   Kräver samma första bokstav, annars matchar "gidlund"
--                   och "nordlund" (båda slutar på "lund").
--   none   (0.00)
create or replace function fn_part_match(p_a text, p_b text)
returns table (score real, kind text)
language sql
immutable
as $$
  select case
    when p_a is null or p_b is null or p_a = '' or p_b = '' then (0::real, 'none'::text)
    when p_a = p_b then (1.0::real, 'exact'::text)
    when (length(p_a) >= 4 and p_b like p_a || '%')
      or (length(p_b) >= 4 and p_a like p_b || '%') then (0.9::real, 'prefix'::text)
    when left(p_a, 1) = left(p_b, 1)
         and levenshtein(p_a, p_b) <= case
               when greatest(length(p_a), length(p_b)) <= 5 then 1
               when greatest(length(p_a), length(p_b)) <= 9 then 2
               else 3
             end then (0.75::real, 'near'::text)
    else (0::real, 'none'::text)
  end;
$$;

-- Delar upp ett namn i förnamn (första ordet) och efternamn (sista ordet).
-- Mellanord ("Anna Maria (Mia) Axelsson") ignoreras.
create or replace function fn_name_parts(p_name text)
returns table (given text, family text, tokens text[])
language sql
immutable
as $$
  with cleaned as (
    select trim(regexp_replace(coalesce(p_name, ''), '[^[:alnum:]]+', ' ', 'g')) as s
  ),
  toks as (
    select coalesce(array_agg(t), '{}'::text[]) as arr
      from cleaned, unnest(string_to_array(s, ' ')) as t
     where t <> ''
  )
  select case when array_length(arr, 1) is null then null
              when array_length(arr, 1) = 1 then arr[1]
              else arr[1] end,
         case when coalesce(array_length(arr, 1), 0) <= 1 then null
              else arr[array_length(arr, 1)] end,
         arr
    from toks;
$$;

-- Jämför två namn delvis. Krävs att BÅDA delarna stämmer för att ett par
-- ska räknas som dubblettkandidat - ett gemensamt förnamn eller
-- efternamn räcker inte ("Mikael Gidlund"/"Mikael Nordlund" är två
-- personer, "Gert"/"Robert Söderberg" är släktingar).
create or replace function fn_name_match(p_a text, p_b text)
returns table (
  given_a text, family_a text,
  given_b text, family_b text,
  given_score real, family_score real,
  given_kind text, family_kind text
)
language sql
immutable
as $$
  with pa as (select * from fn_name_parts(p_a)),
       pb as (select * from fn_name_parts(p_b))
  select pa.given, pa.family, pb.given, pb.family,
         g.score, f.score, g.kind, f.kind
    from pa, pb
    cross join lateral fn_part_match(pa.given, pb.given) g
    cross join lateral fn_part_match(pa.family, pb.family) f;
$$;

-- Par som markerats som "behåll båda" - utesluts ur kandidatlistan så att
-- samma par inte behöver granskas igen.
create table if not exists duplicate_dismissal (
  id           uuid primary key default gen_random_uuid(),
  person_a_id  uuid not null references person(id) on delete cascade,
  person_b_id  uuid not null references person(id) on delete cascade,
  actor        text,
  note         text,
  dismissed_at timestamptz not null default now(),
  unique (person_a_id, person_b_id)
);

-- Dubblettkandidater: par som bör granskas av en människa.
--
-- STARKA kandidater (weak = false) kräver:
--   * samma e-post eller samma telefon, eller
--   * identiskt namn, eller
--   * att BÅDE förnamn och efternamn stämmer (fn_name_match >= 0.75).
--
-- SVAGA par (weak = true) har bara en namndel gemensam - nästan alltid
-- olika personer. De visas i en egen sektion i gränssnittet och kan
-- markeras som "behåll båda", men slås aldrig ihop automatiskt.
--
-- Par som markerats som "behåll båda" (duplicate_dismissal) utesluts.

-- Gamla signatur (utan p_include_weak) tas bort - den skulle krocka.
drop function if exists fn_duplicate_candidates(real);

create or replace function fn_duplicate_candidates(
  p_min_similarity real default 0.45,
  p_include_weak   boolean default false
)
returns table (
  id_a               uuid,
  id_b               uuid,
  name_a             text,
  name_b             text,
  org_a              text,
  org_b              text,
  title_a            text,
  title_b            text,
  email_a            text,
  email_b            text,
  phone_a            text,
  phone_b            text,
  similarity         real,
  same_org           boolean,
  same_email         boolean,
  same_phone         boolean,
  shared_competences int,
  signal             text,
  score              real,
  given_kind         text,
  family_kind        text,
  weak               boolean
)
language sql
stable
as $$
  with pairs as (
    select a.id as id_a,
           b.id as id_b,
           a.full_name as name_a,
           b.full_name as name_b,
           oa.name as org_a,
           ob.name as org_b,
           a.title as title_a,
           b.title as title_b,
           a.email as email_a,
           b.email as email_b,
           a.phone as phone_a,
           b.phone as phone_b,
           a.normalized_name as na,
           b.normalized_name as nb,
           similarity(a.normalized_name, b.normalized_name)::real as sim,
           (oa.id is not null and oa.id = ob.id) as same_org,
           (a.email is not null and b.email is not null and a.email = b.email) as same_email,
           (a.phone is not null and b.phone is not null and a.phone = b.phone) as same_phone,
           (select count(*)::int
              from person_competence ca
              join person_competence cb on cb.competence_id = ca.competence_id
             where ca.person_id = a.id and cb.person_id = b.id) as shared,
           nm.given_score, nm.family_score, nm.given_kind, nm.family_kind
      from person a
      join person b on a.id < b.id
      left join organization oa on oa.id = a.organization_id
      left join organization ob on ob.id = b.organization_id
      cross join lateral fn_name_match(a.full_name, b.full_name) nm
     where (a.email is not null and a.email = b.email)
        or (a.phone is not null and a.phone = b.phone)
        or a.normalized_name = b.normalized_name
        -- Båda namndelarna måste matcha. Ett gemensamt förnamn eller
        -- efternamn räcker INTE - det är oftast släktingar eller
        -- namn coincidence ("Mikael Gidlund" / "Mikael Nordlund").
        or (nm.given_score >= 0.75 and nm.family_score >= 0.75)
        or (p_include_weak
            and ((nm.given_score >= 0.75) or (nm.family_score >= 0.75)))
  )
  select p.id_a,
         p.id_b,
         p.name_a,
         p.name_b,
         p.org_a,
         p.org_b,
         p.title_a,
         p.title_b,
         p.email_a,
         p.email_b,
         p.phone_a,
         p.phone_b,
         p.sim,
         p.same_org,
         p.same_email,
         p.same_phone,
         p.shared,
         case
           when p.same_email then 'samma e-post'
           when p.same_phone then 'samma telefon'
           when p.na = p.nb then 'samma namn'
           -- stark: båda namndelarna stämmer
           when p.given_score >= 0.75 and p.family_score >= 0.75 then
             case
               when p.given_kind = 'exact' and p.family_kind = 'exact' then 'samma namn'
               when p.given_kind = 'prefix' or p.family_kind = 'prefix'
                 then 'samma namn, utökad form'
               else 'samma namn, 1-3 tecken fel'
             end
           -- svag: bara en namndel stämmer - nästan alltid olika personer
           when p.given_score >= 0.75 then
             case when p.given_kind = 'exact' then 'gemensamt förnamn'
                  when p.given_kind = 'prefix' then 'gemensamt förnamn'
                  else 'liknande förnamn' end
           when p.family_score >= 0.75 then
             case when p.family_kind = 'exact' then 'gemensamt efternamn'
                  when p.family_kind = 'prefix' then 'gemensamt efternamn'
                  else 'liknande efternamn' end
           else 'liknande namn'
         end as signal,
         case
           when p.same_email then 1.0
           when p.same_phone then 0.98
           when p.na = p.nb then 0.95
           else (least(p.given_score, p.family_score) * 0.7
                 + greatest(p.given_score, p.family_score) * 0.3)::real
         end as score,
         p.given_kind,
         p.family_kind,
         -- "Svagt" = bara en av namndelarna stämmer. Ofta släktingar.
         not (p.same_email or p.same_phone or p.na = p.nb
              or (p.given_score >= 0.75 and p.family_score >= 0.75)) as weak
    from pairs p
   where not exists (
     select 1 from duplicate_dismissal d
      where (d.person_a_id = p.id_a and d.person_b_id = p.id_b)
         or (d.person_a_id = p.id_b and d.person_b_id = p.id_a)
   )
   order by score desc, p.name_a, p.name_b;
$$;

-- Slå ihop två poster om samma person.
--
-- p_keep = posten som finns kvar. p_drop = posten som raderas.
--
-- Semantik:
--   * Alla kopplingar (källor, kompetenser, anställningar, bevakningslista,
--     kontaktlogg) flyttas till p_keep.
--   * Fält som saknas på p_keep fylls från p_drop. Befintliga värden skrivs
--     aldrig över - den som väljs att behålla styr.
--   * Högst EN aktuell anställningsrad per person: den kuraterade raden
--     (ref is not null) vinner, annars den senaste.
--   * Den raderade postens external_id registreras i person_merge så att
--     frölistan inte skapar tillbaka den vid nästa import.
--   * Hela sammanslagningen sker i en transaktion (funktionsanropet).
create or replace function fn_merge_people(
  p_keep  uuid,
  p_drop  uuid,
  p_actor text default null
) returns jsonb
language plpgsql
as $$
declare
  v_keep   person%rowtype;
  v_drop   person%rowtype;
  v_sources     int := 0;
  v_competences int := 0;
  v_employments int := 0;
  v_watchlist   int := 0;
  v_events      int := 0;
  v_collapsed   int := 0;
  v_basis_a text;
  v_basis_b text;
  v_years_a int;
  v_years_b int;
begin
  select * into v_keep from person where id = p_keep;
  if not found then
    raise exception 'Posten som ska behållas (%) finns inte', p_keep;
  end if;

  select * into v_drop from person where id = p_drop;
  if not found then
    raise exception 'Posten som ska tas bort (%) finns inte', p_drop;
  end if;

  if p_keep = p_drop then
    raise exception 'Kan inte slå ihop en post med sig själv';
  end if;

  -- 1. Källor
  insert into person_source (person_id, source_id)
  select p_keep, ps.source_id
    from person_source ps
   where ps.person_id = p_drop
  on conflict do nothing;
  get diagnostics v_sources = row_count;

  -- 2. Kompetenser
  insert into person_competence (person_id, competence_id)
  select p_keep, pc.competence_id
    from person_competence pc
   where pc.person_id = p_drop
  on conflict do nothing;
  get diagnostics v_competences = row_count;

  -- 3. Anställningar
  update person_employment set person_id = p_keep where person_id = p_drop;
  get diagnostics v_employments = row_count;

  -- 3b. Högst en aktuell rad kvar per person. Den kuraterade raden
  --     (ref is not null) vinner framför legacy-rader.
  with ranked as (
    select e.id,
           row_number() over (
             order by (e.ref is not null) desc, e.valid_from desc nulls last, e.created_at desc
           ) as rn
      from person_employment e
     where e.person_id = p_keep and e.is_current
  )
  update person_employment e
     set is_current = false,
         note = btrim(coalesce(e.note, '') || ' Superseded vid dubblettsammanslagning')
   where e.id in (select id from ranked where rn > 1);
  get diagnostics v_collapsed = row_count;

  -- 4. Bevakningslista. Unika (watchlist_id, person_id) - den dubblerade
  --    raden tas bort om posten som behålls redan finns i listan.
  delete from watchlist_entry we
   where we.person_id = p_drop
     and exists (
       select 1 from watchlist_entry k
        where k.watchlist_id = we.watchlist_id and k.person_id = p_keep
     );
  update watchlist_entry set person_id = p_keep where person_id = p_drop;
  get diagnostics v_watchlist = row_count;

  -- 5. Kontaktlogg (bevis på Art. 14-information ska inte tappa spår)
  update contact_event set person_id = p_keep where person_id = p_drop;
  get diagnostics v_events = row_count;

  -- 6. Fyll luckor på posten som behålls
  select it_experience_basis, it_experience_years into v_basis_a, v_years_a
    from person where id = p_keep;
  select it_experience_basis, it_experience_years into v_basis_b, v_years_b
    from person where id = p_drop;

  update person p
     set title              = coalesce(p.title, v_drop.title),
         email              = coalesce(p.email, v_drop.email),
         phone              = coalesce(p.phone, v_drop.phone),
         organization_id    = coalesce(p.organization_id, v_drop.organization_id),
         location           = coalesce(p.location, v_drop.location),
         location_confidence = case
                                when p.location is null then v_drop.location_confidence
                                else p.location_confidence
                              end,
         linkedin_slug      = coalesce(p.linkedin_slug, v_drop.linkedin_slug),
         linkedin_urn       = coalesce(p.linkedin_urn, v_drop.linkedin_urn),
         seniority          = coalesce(p.seniority, v_drop.seniority),
         notes              = coalesce(p.notes, v_drop.notes),
         available_from     = coalesce(p.available_from, v_drop.available_from),
         contact_published  = p.contact_published or v_drop.contact_published,
         spoken_languages   = (
           select coalesce(array_agg(distinct x order by x), '{}'::text[])
             from unnest(p.spoken_languages || v_drop.spoken_languages) as x
         ),
         it_experience_years = case
                                when v_years_a is null then v_years_b
                                when v_years_b is null then v_years_a
                                when v_basis_a = 'explicit' and v_basis_b <> 'explicit' then v_years_a
                                when v_basis_b = 'explicit' and v_basis_a <> 'explicit' then v_years_b
                                else greatest(v_years_a, v_years_b)
                              end,
         it_experience_basis = case
                                when v_basis_a = 'explicit' then 'explicit'
                                when v_basis_b = 'explicit' then 'explicit'
                                when v_basis_a = 'documented' then 'documented'
                                when v_basis_b = 'documented' then 'documented'
                                when v_basis_a = 'notes' then 'notes'
                                when v_basis_b = 'notes' then 'notes'
                                else coalesce(v_basis_a, v_basis_b)
                              end,
         updated_at = now()
   where p.id = p_keep;

  -- 7. Registrera sammanslagningen så att importen inte skapar tillbaka posten
  insert into person_merge (dropped_external_id, dropped_name, dropped_detail,
                            keep_person_id, keep_external_id, actor, note)
  values (
    v_drop.external_id,
    v_drop.full_name,
    jsonb_build_object(
      'id', v_drop.id,
      'title', v_drop.title,
      'email', v_drop.email,
      'phone', v_drop.phone,
      'organization_id', v_drop.organization_id,
      'location', v_drop.location,
      'it_experience_years', v_drop.it_experience_years,
      'it_experience_basis', v_drop.it_experience_basis
    ),
    p_keep,
    v_keep.external_id,
    p_actor,
    'Dubblettsammanslagning via fn_merge_people'
  )
  on conflict (dropped_external_id) do update
     set keep_person_id   = excluded.keep_person_id,
         keep_external_id = excluded.keep_external_id,
         merged_at        = now(),
         actor            = excluded.actor;

  -- 8. Radera den dubblerade posten (kopplingar har redan flyttats)
  delete from person where id = p_drop;

  -- 9. Spår i audit_log
  insert into audit_log (actor, action, table_name, row_id, detail)
  values (
    p_actor,
    'merge_person',
    'person',
    v_drop.external_id,
    jsonb_build_object(
      'kept_external_id', v_keep.external_id,
      'kept_name', v_keep.full_name,
      'dropped_name', v_drop.full_name,
      'sources_moved', v_sources,
      'competences_moved', v_competences,
      'employments_moved', v_employments,
      'current_rows_collapsed', v_collapsed,
      'watchlist_moved', v_watchlist,
      'contact_events_moved', v_events
    )
  );

  return jsonb_build_object(
    'kept_id', p_keep,
    'kept_external_id', v_keep.external_id,
    'dropped_external_id', v_drop.external_id,
    'dropped_name', v_drop.full_name,
    'sources_moved', v_sources,
    'competences_moved', v_competences,
    'employments_moved', v_employments,
    'current_rows_collapsed', v_collapsed,
    'watchlist_moved', v_watchlist,
    'contact_events_moved', v_events
  );
end;
$$;

-- Dokumenterad erfarenhet: antal månader i IT, beräknat ur daterad
-- anställningshistorik. Intervall slås ihop först (en konsult kan ha haft
-- flera roller samtidigt) så att ingen månad räknas två gånger.
--
--   Rader utan startdatum hoppas över (perioden är helt okänd).
--   Tidsatta men slutdatum okända (valid_to IS NULL, is_current = false)
--     hoppas också över - de bidrar inte till en säker årssiffra.
--   Pågående tjänst (is_current = true) räknas till dagens datum.
create or replace function fn_documented_experience(p_person uuid)
returns integer
language sql
stable
as $$
  with e as (
    select valid_from as d1,
           coalesce(valid_to, current_date) as d2
    from person_employment
    where person_id = p_person
      and valid_from is not null
      and (valid_to is not null or is_current)
  ), s as (
    select d1, d2,
           max(d2) over (order by d1 rows between unbounded preceding and 1 preceding) as running_end
    from e
  ), m as (
    select d1, d2,
           case when running_end is null or d1 > running_end then 1 else 0 end as is_start
    from s
  ), merged as (
    select sum(is_start) over (order by d1 rows unbounded preceding) as grp, d1, d2
    from m
  ), agg as (
    select grp, min(d1) as start_d, max(d2) as end_d
    from merged
    group by grp
  )
  select coalesce(sum(
           extract(year  from age(end_d, start_d))::int * 12
         + extract(month from age(end_d, start_d))::int
         ), 0)::int
  from agg;
$$;

-- GDPR-gallring: raderar personer vars retention datum passerat (sparar logg)
create or replace function fn_purge_expired_personal_data(p_actor text default 'cron')
returns int
language plpgsql
as $$
declare
  n int;
begin
  with victims as (
    select id, full_name from person
    where retention_until is not null
      and retention_until < current_date
      and contact_state not in ('hired','in_process')
  ), deleted as (
    delete from person p using victims v
    where p.id = v.id
    returning p.id, v.full_name
  )
  insert into audit_log (actor, action, table_name, row_id, detail)
  select p_actor, 'gdpr_retention_purge', 'person', d.id::text,
         jsonb_build_object('full_name', d.full_name, 'reason', 'retention_until passed')
  from deleted d;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Vyer
-- ---------------------------------------------------------------------------

-- Fullständig personvy med organisation, kompetenser, källor
create or replace view v_people_full as
select
  p.id,
  p.external_id,
  p.full_name,
  p.title,
  p.seniority,
  o.name as organization,
  o.kind as organization_kind,
  p.location,
  p.location_confidence,
  p.data_confidence,
  p.linkedin_urn,
  p.linkedin_slug,
  p.email,
  p.phone,
  p.contact_published,
  p.contact_state,
  p.do_not_contact,
  p.retention_until,
  coalesce(
    (select array_agg(c.tag order by c.tag)
       from person_competence pc join competence c on c.id = pc.competence_id
      where pc.person_id = p.id),
    '{}'::text[]) as competences,
  (select count(*) from person_source ps where ps.person_id = p.id) as source_count,
  (select array_agg(s.url) from person_source ps join source s on s.id = ps.source_id
    where ps.person_id = p.id) as source_urls,
  p.created_at,
  p.updated_at,
  -- Nya kolumner läggs sist: 'create or replace view' kan bara appenda.
  p.it_experience_years,
  p.it_experience_basis,
  p.available_from,
  p.spoken_languages,
  fn_documented_experience(p.id) as documented_months,
  (select count(*) from person_employment e where e.person_id = p.id)::int as employment_count
from person p
left join organization o on o.id = p.organization_id;

-- ---------------------------------------------------------------------------
-- CV-vy: en rad per anställning - var, vad, hur länge
-- ---------------------------------------------------------------------------
create or replace view v_cv as
select
  p.id            as person_id,
  p.external_id,
  p.full_name,
  e.id            as employment_id,
  e.ref,
  e.title,
  e.seniority,
  e.employment_type,
  e.is_current,
  e.valid_from,
  e.valid_to,
  o.name          as organization,
  o.kind          as organization_kind,
  e.stack,
  e.note,
  e.confidence,
  s.url           as source_url,
  s.title         as source_title,
  s.accessed_at   as source_accessed_at,
  case when e.valid_from is null then null
       else extract(year  from age(coalesce(e.valid_to, current_date), e.valid_from))::int * 12
          + extract(month from age(coalesce(e.valid_to, current_date), e.valid_from))::int
  end             as months,
  (select array_agg(c.tag order by c.tag)
     from employment_competence ec join competence c on c.id = ec.competence_id
    where ec.employment_id = e.id) as competences
from person_employment e
join person p on p.id = e.person_id
left join organization o on o.id = e.organization_id
left join source s on s.id = e.source_id;

-- Export för Teams-bevakningslistan (få kolumner, inga extra personuppgifter)
create or replace view v_watchlist_export as
select
  w.name        as watchlist,
  w.owner_email as watchlist_owner,
  p.external_id,
  p.full_name,
  p.title,
  o.name        as organization,
  p.location,
  p.linkedin_slug,
  p.email,
  p.contact_state,
  e.added_at,
  e.last_contacted,
  e.next_action
from watchlist_entry e
join watchlist w on w.id = e.watchlist_id
join person p    on p.id = e.person_id
left join organization o on o.id = p.organization_id;

-- Täckningsstatistik
create or replace view v_coverage as
select
  count(*) filter (where true)                                  as persons_total,
  count(*) filter (where data_confidence = 'high')               as conf_high,
  count(*) filter (where data_confidence = 'medium')             as conf_medium,
  count(*) filter (where data_confidence = 'low')                as conf_low,
  count(*) filter (where email is not null)                      as with_email,
  count(*) filter (where linkedin_slug is not null)              as with_linkedin,
  count(*) filter (where source_count > 0)                       as with_source,
  count(*) filter (where do_not_contact)                         as do_not_contact
from v_people_full;

-- ---------------------------------------------------------------------------
-- Trigger: uppdatera updated_at
-- ---------------------------------------------------------------------------
create or replace function fn_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists t_person_touch on person;
create trigger t_person_touch before update on person
  for each row execute function fn_touch_updated_at();

drop trigger if exists t_org_touch on organization;
create trigger t_org_touch before update on organization
  for each row execute function fn_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Uppdragsmatchning: rangordna kandidater mot en kravprofil
--
--   fn_match_candidates(p_profile uuid)
--
-- Två designprinciper:
--   1. Poängen är alltid DELPOÄNG. Varje del redovisas separat, så att
--      beslutet kan förklaras och ifrågasättas.
--   2. En gissad uppgift väger mindre än en belagd. Erfarenhet som bygger på
--      rollnivå ("seniority") räknas som uppskattad och syns som det.
-- ---------------------------------------------------------------------------

-- Kravprofil för ett uppdrag. Vikterna ligger i weights (jsonb) så att de
-- kan justeras per uppdrag utan kodändring.
create table if not exists job_profile (
  id                 uuid primary key default gen_random_uuid(),
  slug               text unique,                    -- idempotent nyckel för seed
  title              text        not null,
  client_name        text,
  notes              text,
  must_have          text[]      not null default '{}',   -- kompetenstaggar
  min_must_have      integer,                              -- hur många som minst krävs
  nice_to_have       text[]      not null default '{}',
  min_seniority      text check (min_seniority in
                       ('cxo','chef','lead','senior','mid','junior')),
  min_experience_years integer,
  required_location  text,
  accepted_locations text[]      not null default '{}',   -- t.ex. pendelorter
  required_languages text[]      not null default '{}',
  available_by       date,                               -- senast tillgänglig
  weights            jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table job_profile is
  'Kravprofil per uppdrag. must_have/nice_to_have är taggar ur kompetenstaxonomin. min_must_have: hur många must-have som minst krävs (null = alla). weights: must_have, nice_to_have, experience, seniority, location, language, availability, confidence.';

-- ---------------------------------------------------------------------------
-- Matchningsfunktionen
-- ---------------------------------------------------------------------------
create or replace function fn_match_candidates(p_profile uuid)
returns table (
  person_id          uuid,
  full_name          text,
  title              text,
  organization       text,
  score              numeric,   -- 0-100, viktat
  eligible           boolean,   -- false om en must-have saknas
  must_score         numeric,
  nice_score         numeric,
  experience_score   numeric,
  seniority_score    numeric,
  location_score     numeric,
  language_score     numeric,
  availability_score numeric,
  confidence_score   numeric,
  documented_months  integer,
  experience_years   integer,
  experience_basis   text,
  seniority          text,
  location           text,
  must_covered       integer,
  must_total         integer,
  must_missing       text[],
  nice_covered       integer,
  nice_total         integer,
  explanation        text[]
)
language sql
stable
as $$
with prof as (
  select jp.*,
         coalesce((jp.weights->>'must_have')::numeric, 40)       as w_must,
         coalesce((jp.weights->>'nice_to_have')::numeric, 10)     as w_nice,
         coalesce((jp.weights->>'experience')::numeric, 15)       as w_exp,
         coalesce((jp.weights->>'seniority')::numeric, 10)        as w_sen,
         coalesce((jp.weights->>'location')::numeric, 10)         as w_loc,
         coalesce((jp.weights->>'language')::numeric, 5)          as w_lang,
         coalesce((jp.weights->>'availability')::numeric, 5)      as w_avail,
         coalesce((jp.weights->>'confidence')::numeric, 5)        as w_conf,
         coalesce(cardinality(jp.must_have), 0) > 0             as has_must,
         coalesce(jp.min_must_have, cardinality(jp.must_have)) as must_target,
         coalesce(cardinality(jp.nice_to_have), 0) > 0          as has_nice,
         coalesce(cardinality(jp.required_languages), 0) > 0    as has_lang,
         jp.min_experience_years is not null                    as has_exp,
         jp.min_seniority is not null                           as has_sen,
         (jp.required_location is not null
            or coalesce(cardinality(jp.accepted_locations), 0) > 0) as has_loc,
         jp.available_by is not null                            as has_avail,
         -- En profil utan krav är ett misstag, inte en matchning.
         (coalesce(cardinality(jp.must_have), 0) > 0
          or coalesce(cardinality(jp.nice_to_have), 0) > 0
          or jp.min_experience_years is not null
          or jp.min_seniority is not null
          or jp.required_location is not null
          or coalesce(cardinality(jp.accepted_locations), 0) > 0
          or coalesce(cardinality(jp.required_languages), 0) > 0
          or jp.available_by is not null)                     as has_criteria
    from job_profile jp
   where jp.id = p_profile
),
levels as (
  select * from (values
    ('junior', 1), ('mid', 2), ('senior', 3), ('lead', 4), ('cxo', 5), ('chef', 5)
  ) as t(lvl, n)
),
persons as (
  select p.id,
         p.full_name,
         p.title,
         o.name as organization,
         p.location,
         p.seniority,
         p.it_experience_years,
         p.it_experience_basis,
         p.data_confidence,
         p.spoken_languages,
         p.available_from,
         fn_documented_experience(p.id) as documented_months,
         -- livslångsaggregatet
         coalesce((select array_agg(distinct c.tag)
                     from person_competence pc
                     join competence c on c.id = pc.competence_id
                    where pc.person_id = p.id), '{}') as life_tags,
         -- teknik under specifika anställningar
         coalesce((select array_agg(distinct c.tag)
                     from employment_competence ec
                     join competence c on c.id = ec.competence_id
                     join person_employment e on e.id = ec.employment_id
                    where e.person_id = p.id), '{}') as job_tags
    from person p
    left join organization o on o.id = p.organization_id
),
must_hits as (
  select ps.id,
         count(*) filter (where ps.life_tags @> array[m.tag]
                            or ps.job_tags @> array[m.tag])::int as covered,
         array_agg(m.tag) filter (where ps.life_tags @> array[m.tag] is not true
                            and ps.job_tags @> array[m.tag] is not true) as missing
    from persons ps
    cross join prof pr
    cross join lateral unnest(pr.must_have) as m(tag)
   group by ps.id
),
nice_hits as (
  select ps.id,
         count(*) filter (where ps.life_tags @> array[n.tag]
                            or ps.job_tags @> array[n.tag])::int as covered
    from persons ps
    cross join prof pr
    cross join lateral unnest(pr.nice_to_have) as n(tag)
   group by ps.id
),
scored as (
  select ps.id,
         ps.full_name,
         ps.title,
         ps.organization,
         ps.location,
         ps.seniority,
         ps.it_experience_years,
         ps.it_experience_basis,
         ps.documented_months,
         ps.spoken_languages,
         ps.available_from,
         ps.data_confidence,
         pr.has_must, pr.must_target, pr.has_nice, pr.has_exp, pr.has_sen,
         pr.has_loc, pr.has_lang, pr.has_avail,
         pr.must_have, pr.nice_to_have, pr.required_languages,
         pr.min_experience_years, pr.min_seniority,
         pr.required_location, pr.accepted_locations, pr.available_by,
         pr.w_must, pr.w_nice, pr.w_exp, pr.w_sen, pr.w_loc,
         pr.w_lang, pr.w_avail, pr.w_conf,
         coalesce(mh.covered, 0) as must_covered,
         coalesce(mh.missing, '{}') as must_missing,
         coalesce(nh.covered, 0) as nice_covered,
         -- erfarenhet: dokumenterad om den finns, annars uppskattad
         case when ps.documented_months > 0 then ps.documented_months / 12.0
              else ps.it_experience_years end::numeric as years_used,
         case when ps.documented_months > 0 then 'documented'
              else coalesce(ps.it_experience_basis, 'unknown') end as basis_used,
         -- senioritetsnivå
         coalesce((select l.n from levels l where l.lvl = ps.seniority), 0) as sen_level,
         coalesce((select l.n from levels l where l.lvl = pr.min_seniority), 0) as req_level
    from persons ps
    cross join prof pr
    left join must_hits mh on mh.id = ps.id
    left join nice_hits nh on nh.id = ps.id
   where pr.has_criteria
),
points as (
  select s.*,
    -- must-have: andel täckta taggar
    case when s.has_must
         then round(100.0 * s.must_covered / greatest(cardinality(s.must_have), 1), 1)
         else null end as must_points,
    case when s.has_nice
         then round(100.0 * s.nice_covered / greatest(cardinality(s.nice_to_have), 1), 1)
         else null end as nice_points,
    -- erfarenhet: minsta år mot kravet
    case when s.has_exp
         then round(least(100.0,
              100.0 * coalesce(s.years_used, 0)
                    / greatest(s.min_experience_years, 1)), 1)
         else null end as exp_points,
    -- senioritet: under kravet kostar 25 poäng per nivå, överkvalificering straffas inte
    case when s.has_sen
         then round(greatest(0, 100 - 25 * greatest(s.req_level - s.sen_level, 0)), 1)
         else null end as sen_points,
    -- ort: kravort 100, pendelort 70, okänd ort 40, annan ort 0
    case when s.has_loc
         then case
                when s.location is not null and s.location = s.required_location then 100
                when s.location is not null and s.location = any(s.accepted_locations) then 70
                when s.location is null or s.location = ''
                     or s.location ilike 'okänd%' then 40
                else 0
              end
         else null end as loc_points,
    -- språk: ingen data ger neutrala 50, aldrig 0
    case when s.has_lang
         then case
                when s.spoken_languages is null
                  or cardinality(s.spoken_languages) = 0 then 50
                else round(100.0 * (
                       select count(*) from unnest(s.required_languages) l
                        where l = any(s.spoken_languages)
                     )::numeric / greatest(cardinality(s.required_languages), 1), 1)
              end
         else null end as lang_points,
    -- tillgänglighet: ingen data ger neutrala 50
    case when s.has_avail
         then case
                when s.available_from is null then 50
                when s.available_from <= s.available_by then 100
                else 0
              end
         else null end as avail_points,
    -- datakonfidens: hur mycket av bilden som är belagd
    round(100.0 * (
        0.6 * case s.data_confidence
                when 'high' then 1.0 when 'medium' then 0.7
                when 'low' then 0.4 else 0.3 end
      + 0.4 * case when s.documented_months > 0 then 1.0
                   when s.it_experience_basis = 'explicit' then 0.8
                   when s.it_experience_basis = 'notes' then 0.65
                   when s.it_experience_basis = 'seniority' then 0.4
                   else 0.25 end
    ), 1) as conf_points
  from scored s
),
totalled as (
  select p.*,
    (case when p.has_must  then p.w_must  else 0 end)
  + (case when p.has_nice  then p.w_nice  else 0 end)
  + (case when p.has_exp   then p.w_exp   else 0 end)
  + (case when p.has_sen   then p.w_sen   else 0 end)
  + (case when p.has_loc   then p.w_loc   else 0 end)
  + (case when p.has_lang  then p.w_lang  else 0 end)
  + (case when p.has_avail then p.w_avail else 0 end)
  + p.w_conf as active_weight,
    (case when p.has_must  then p.w_must  * p.must_points  else 0 end)
  + (case when p.has_nice  then p.w_nice  * p.nice_points  else 0 end)
  + (case when p.has_exp   then p.w_exp   * p.exp_points   else 0 end)
  + (case when p.has_sen   then p.w_sen   * p.sen_points   else 0 end)
  + (case when p.has_loc   then p.w_loc   * p.loc_points   else 0 end)
  + (case when p.has_lang  then p.w_lang  * p.lang_points  else 0 end)
  + (case when p.has_avail then p.w_avail * p.avail_points else 0 end)
  + p.w_conf * p.conf_points as weighted_sum
  from points p
)
select
  t.id as person_id,
  t.full_name,
  t.title,
  t.organization,
  case when t.active_weight = 0 then null
       else round(t.weighted_sum / t.active_weight, 1) end as score,
  (not t.has_must or t.must_covered >= t.must_target) as eligible,
  t.must_points as must_score,
  t.nice_points as nice_score,
  t.exp_points as experience_score,
  t.sen_points as seniority_score,
  t.loc_points as location_score,
  t.lang_points as language_score,
  t.avail_points as availability_score,
  t.conf_points as confidence_score,
  t.documented_months,
  t.it_experience_years as experience_years,
  t.basis_used as experience_basis,
  t.seniority,
  t.location,
  t.must_covered,
  cardinality(t.must_have) as must_total,
  t.must_missing,
  t.nice_covered,
  cardinality(t.nice_to_have) as nice_total,
  array_remove(array[
    case when t.has_must
         then format('%s av %s must-have täcker%s%s',
              t.must_covered, cardinality(t.must_have),
              case when t.must_target < cardinality(t.must_have)
                   then format(' (minst %s krävs)', t.must_target) else '' end,
              case when t.must_covered < t.must_target
                   then ' - saknar: ' || array_to_string(t.must_missing, ', ')
                   else '' end)
    end,
    case when t.has_nice
         then format('%s av %s nice-to-have täcker',
              t.nice_covered, cardinality(t.nice_to_have))
    end,
    case when t.has_exp
         then case when t.documented_months > 0
                   then format('dokumenterad erfarenhet %s år (krav %s år)%s',
                        round(t.documented_months / 12.0, 1), t.min_experience_years,
                        case when t.it_experience_years is not null
                             and t.it_experience_years <> round(t.documented_months / 12.0)
                             then format(' - angivet totalt %s år',
                                  t.it_experience_years)
                             else '' end)
                   when t.years_used is null
                   then 'erfarenhet okänd (krav ' || t.min_experience_years || ' år)'
                   else format('%s (krav %s år)',
                        case t.basis_used
                          when 'explicit' then 'angiven erfarenhet ' || round(t.years_used, 1) || ' år'
                          when 'notes'    then 'erfarenhet utläst ur anteckningar ' || round(t.years_used, 1) || ' år'
                          when 'seniority' then 'uppskattad erfarenhet ' || round(t.years_used, 1) || ' år (grund: rollnivå)'
                          else 'erfarenhet okänd'
                        end,
                        t.min_experience_years)
              end
    end,
    case when t.has_sen
         then format('senioritet %s (krav %s)', t.seniority, t.min_seniority)
    end,
    case when t.has_loc
         then case when t.location is null or t.location = ''
                        or t.location ilike 'okänd%'
                   then 'ort okänd (krav ' || coalesce(t.required_location, 'ingen') || ')'
                   else format('ort %s', t.location) end
    end,
    case when t.has_lang
         then case when t.spoken_languages is null
                        or cardinality(t.spoken_languages) = 0
                   then 'språk: ingen data'
                   else format('språk: %s', array_to_string(t.spoken_languages, ', '))
              end
    end,
    case when t.has_avail
         then case when t.available_from is null then 'tillgänglighet: ingen data'
                   else format('tillgänglig från %s', t.available_from) end
    end,
    format('datakonfidens %s', t.data_confidence),
    case when t.documented_months = 0 and t.it_experience_basis = 'seniority'
         then 'erfarenheten bygger på rollnivå, inte på dokumenterad historik'
    end
  ], null) as explanation
from totalled t
-- Sortering: först hur väl kravet täcks (must-have, sedan nice-to-have),
-- sedan poängen. Poängen ensam diskriminerar dåligt - de flesta kandidater
-- har ort rätt och senioritet över krav, så poängen hamnar ihop.
order by (not t.has_must or t.must_covered >= t.must_target) desc,
         t.must_covered desc,
         t.nice_covered desc,
         (case when t.active_weight = 0 then null
               else t.weighted_sum / t.active_weight end) desc nulls last,
         t.full_name;
$$;


-- ---------------------------------------------------------------------------
-- Exempelprofil - vad en kravprofil ser ut i praktiken
--
-- Notera: must_have bör normalt vara EN tagg. Den här databasen har
-- sällsynta taggar, och "system_development + information_security + cloud"
-- som krav gör nästan alla kandideter underkända (max täckning var 1 av 3).
-- Vill man kräva flera taggar används min_must_have, t.ex. "minst 2 av 3".
-- ---------------------------------------------------------------------------
insert into job_profile
  (slug, title, client_name, notes, must_have, min_must_have, nice_to_have,
   min_seniority, min_experience_years, required_location, accepted_locations,
   required_languages, weights)
values
  ('exempel-systemutvecklare',
   'Senior systemutvecklare med säkerhetsansvar',
   'Exempelkund i Sundsvall',
   'Exempelprofil för att prova vikterna. Vikterna justeras i weights (jsonb) - ingen kodändring behövs.',
   array['system_development'], 1,
   array['cloud','information_security','it_leadership'],
   'senior', 8, 'Sundsvall',
   array['Örnsköldsvik'],
   array['svenska','engelska'],
   '{"must_have":40,"nice_to_have":10,"experience":15,"seniority":10,"location":10,"language":5,"availability":5,"confidence":5}'::jsonb)
on conflict (slug) do update
  set title = excluded.title,
      notes = excluded.notes,
      must_have = excluded.must_have,
      min_must_have = excluded.min_must_have,
      nice_to_have = excluded.nice_to_have,
      min_seniority = excluded.min_seniority,
      min_experience_years = excluded.min_experience_years,
      required_location = excluded.required_location,
      accepted_locations = excluded.accepted_locations,
      required_languages = excluded.required_languages,
      weights = excluded.weights,
      updated_at = now();

-- ---------------------------------------------------------------------------
-- Kommentarar
-- ---------------------------------------------------------------------------
comment on table  person is 'Kandidater. Endast personer med källa (person_source) bör finnas här.';
comment on column person.retention_until is 'Datum då uppgifterna ska raderas om inte nytt intresse uppstått.';
comment on column person.it_experience_years is 'Minsta antal år personen varit i IT. Null = okänt - får aldrig räknas som 3+ år.';
comment on column person.it_experience_basis is 'Grund för it_experience_years: explicit (YAML), documented (daterad anställningshistorik), notes (ur fritext) eller seniority (undre gräns från rollnivå).';
comment on column person.available_from is 'När personen kan börja på nytt uppdrag. Null = okänt.';
comment on table  person_employment is 'Anställningshistorik i CV-format: var, vad, hur länge. Utan källa -> ska inte finnas här.';
comment on column person_employment.valid_to is 'Slutdatum. NULL + is_current = false betyder "slutdatum okänt", NULL + is_current = true betyder pågående.';
comment on column person_employment.ref is 'Idempotent nyckel mot data/employment-history.yaml, så importen uppdaterar i stället för att duplicera.';
comment on column person_employment.confidence is 'Hur väl dokumenterad raden är: high (belagd av källa), medium (utläst ur fritext), low (hypotes).';
comment on table  employment_competence is 'Teknik per anställning - t.ex. "vilken stack på CGI?".';
comment on function fn_documented_experience is 'Antal månader i IT beräknat ur daterad anställningshistorik. Slår ihop överlappande intervall.';
comment on column person.lawful_basis is 'Rättslig grund enligt GDPR Art. 6. Default: legitimate_interests.';
comment on table  contact_event is 'Logg över kontaktförsök. Bevisar Art. 14-information och möjliggör av-saknad-av-kontaktlista.';
comment on table  dsr_request is 'Begäran från personuppgiftssubjekt. Loggas även efter att personraderats.';
comment on function fn_find_duplicates is 'Fuzzy dubblettkoll inför import. Bör köras INNAN varje ny post sparas.';
comment on function fn_duplicate_candidates is 'Dubblettkandidater för granskning. Kräver att både förnamn och efternamn stämmer (eller samma e-post/telefon). Returnerar par - aldrig ett "sant"-svar.';
comment on function fn_part_match is 'Matchar ett ord: exact (1.0), prefix (0.9), near (0.75) eller none.';
comment on function fn_name_match is 'Jämför förnamn och efternamn var för sig. Krävs att båda delarna stämmer för att ett par ska vara dubblettkandidat.';
comment on table duplicate_dismissal is 'Par som markerats som "behåll båda" - utesluts ur kandidatlistan.';
comment on function fn_merge_people is 'Slår ihop två poster om samma person. Flyttar kopplingar, fyller luckor och registrerar den raderade postens external_id i person_merge.';
comment on table person_merge is 'Logg över sammanslagna dubbletter. Importer hoppar över external_id som finns här.';
comment on function fn_match_candidates is 'Rankar kandidater mot en kravprofil. Returnerar viktad poäng 0-100, delpoäng per del, matchade/missade must-have och en förklaring per person.';
comment on function fn_purge_expired_personal_data is 'Gallrar personer vars retention_until passerat. Kör via pg_cron eller manuellt.';

-- ============================================================================
-- Rekryteringspipeline (kanban)
--
-- Flödet som rekryteringsflödet faktiskt har:
--   sourced -> teams_check -> review -> contacted -> lunch -> paper -> hired
--   (dropped = bortfall, med orsak)
--
-- Designprinciper:
--   1. EN rad per (person, roll). Samma person kan vara aktuell för flera
--      roller; boarden grupperar per person, kolumnen är den fördelade stegen.
--   2. Sourcing (sökväg) är ett attribut, inte ett stadium - "solla" är de
--      filter som redan finns pa /kandidater.
--   3. Varje stage-flytt loggas i pipeline_event, sa att flödet går att
--      folja i efterhand (vem som tog beslutet, nar, varfor).
--   4. Granskning (review) kravar TVa roster: en anstalld och en grundare.
-- ============================================================================

do $$ begin
  create type pipeline_stage as enum
    ('sourced','teams_check','review','contacted','lunch','paper','hired','dropped');
exception when duplicate_object then null; end $$;

do $$ begin
  create type pipeline_voter_role as enum ('employee','founder');
exception when duplicate_object then null; end $$;

do $$ begin
  create type pipeline_source as enum
    ('linkedin','arbetsforrmedlingen','boolag','myndighet',
     'it_bolag_sundsvall','soulmate_kontakt','annat');
exception when duplicate_object then null; end $$;

comment on type pipeline_stage is
  'Rekryteringssteg. sourced->teams_check->review->contacted->lunch->paper->hired, dropped = bortfall.';
comment on type pipeline_source is
  'Sokvag: var kandidaten hittades. linkedin|arbetsforrmedlingen|boolag|myndighet|it_bolag_sundsvall|soulmate_kontakt|annat.';

-- ---------------------------------------------------------------------------
-- Rorare - vem som kan tumma upp (anstald eller grundare)
-- ---------------------------------------------------------------------------
create table if not exists pipeline_voter (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  role       pipeline_voter_role not null default 'employee',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Pipeline-rad: en person i en roll
-- ---------------------------------------------------------------------------
create table if not exists candidate_pipeline (
  id               uuid primary key default gen_random_uuid(),
  person_id        uuid not null references person(id) on delete cascade,
  role_label       text not null default 'Okand roll',
  stage            pipeline_stage not null default 'sourced',
  source           pipeline_source not null default 'annat',
  source_note      text,
  owner_id         uuid references pipeline_voter(id) on delete set null,
  note             text,
  drop_reason      text,
  teams_ref        text,                 -- id pa Planner-kortet, om det finns
  entered_stage_at timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint candidate_pipeline_unique unique (person_id, role_label)
);
create index if not exists pipeline_stage_idx  on candidate_pipeline (stage);
create index if not exists pipeline_person_idx on candidate_pipeline (person_id);

drop trigger if exists t_pipeline_touch on candidate_pipeline;
create trigger t_pipeline_touch before update on candidate_pipeline
  for each row execute function fn_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Stage-historik - vem som tog beslutet, nar och varfor
-- ---------------------------------------------------------------------------
create table if not exists pipeline_event (
  id         bigserial primary key,
  pipeline_id uuid not null references candidate_pipeline(id) on delete cascade,
  from_stage pipeline_stage,
  to_stage   pipeline_stage not null,
  actor      text,
  note       text,
  at         timestamptz not null default now()
);
create index if not exists pipeline_event_pipeline on pipeline_event (pipeline_id, at desc);

-- ---------------------------------------------------------------------------
-- Rost - en anstalld och en grundare per granskningskort
-- ---------------------------------------------------------------------------
create table if not exists pipeline_vote (
  id          uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references candidate_pipeline(id) on delete cascade,
  voter_id    uuid not null references pipeline_voter(id) on delete cascade,
  voter_role  pipeline_voter_role not null,
  approved    boolean not null,
  note        text,
  at          timestamptz not null default now(),
  constraint pipeline_vote_unique unique (pipeline_id, voter_role)
);

-- ---------------------------------------------------------------------------
-- Planner-kort (Teams "Rekrytering"-listan)
--
-- Korten importeras fra CSV (manuell export ur Planner) tills Graph-behorighet
-- finns i tenanten. Matchningen mot personregistret sker i fn_match_person.
-- ---------------------------------------------------------------------------
create table if not exists planner_card (
  id            uuid primary key default gen_random_uuid(),
  external_id   text not null unique,
  title         text not null,
  bucket        text,
  description   text,
  organization  text,                       -- organisation som stod i kortet
  linkedin_slug text,
  raw           jsonb not null default '{}'::jsonb,
  person_id     uuid references person(id) on delete set null,
  match_score   real,
  match_kind    text,
  imported_at   timestamptz not null default now()
);
create index if not exists planner_card_person on planner_card (person_id);

-- Kolumnen lades till efter att tabellen skapades - 'create table if not
-- exists' ändrar inte en tabell som redan finns.
alter table planner_card add column if not exists organization text;

-- ---------------------------------------------------------------------------
-- Matchning: Planner-kort -> person i registret
--
-- 1. Exakt normaliserat namn -> score 1.0 (kind 'exact')
-- 2. Annars fn_name_match: bada namndelar >= 0.75 -> score = medel
-- 3. Organisationen ska stamma nar den anges - annars sanks score och
--    kind blir 'name_only' (manniskans bedomning kvar).
-- 4. Under 0.75 matchar inget - kortet visas som omatchat och lases hand.
-- ---------------------------------------------------------------------------
create or replace function fn_match_person(p_name text, p_org text default null)
returns table (
  person_id   uuid,
  full_name   text,
  organization text,
  score       real,
  kind        text
)
language sql
stable
as $$
  with cands as (
    select p.id,
           p.full_name,
           o.name as organization,
           p.normalized_name,
           coalesce(fn_normalize(o.name), '') as org_norm,
           nm.given_score,
           nm.family_score
      from person p
      left join organization o on o.id = p.organization_id
      cross join lateral fn_name_match(p_name, p.full_name) nm
     where p_name is not null and btrim(p_name) <> ''
  ),
  scored as (
    select c.*,
           case when c.normalized_name = fn_normalize(p_name)
                then 1.0
                else (c.given_score + c.family_score) / 2
           end as name_score,
           (p_org is not null and btrim(p_org) <> ''
              and c.org_norm = fn_normalize(p_org)) as org_match
      from cands c
  )
  select s.id,
         s.full_name,
         s.organization,
         (case when s.org_match or s.name_score >= 1.0
               then s.name_score
               else s.name_score * 0.9 end)::real,
         case when s.normalized_name = fn_normalize(p_name) then 'exact'
              when s.org_match then 'name+org'
              else 'name_only' end
    from scored s
   where s.name_score >= 0.75
     and (
       p_org is null or btrim(p_org) = '' or s.org_match
       or s.name_score >= 0.9
     )
   order by (case when s.org_match then 0 else 1 end), s.name_score desc, s.full_name
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Vyer for boarden
-- ---------------------------------------------------------------------------
create or replace view v_pipeline_board as
select cp.id,
       cp.person_id,
       p.full_name,
       o.name as organization,
       p.title,
       p.location,
       p.email,
       p.phone,
       p.do_not_contact,
       p.linkedin_slug,
       cp.role_label,
       cp.stage,
       cp.source,
       cp.source_note,
       cp.note,
       cp.drop_reason,
       cp.teams_ref,
       cp.owner_id,
       ov.name as owner_name,
       ov.role as owner_role,
       cp.entered_stage_at,
       cp.updated_at
  from candidate_pipeline cp
  join person p on p.id = cp.person_id
  left join organization o on o.id = p.organization_id
  left join pipeline_voter ov on ov.id = cp.owner_id;

create or replace view v_pipeline_votes as
select v.pipeline_id,
       v.voter_role,
       v.approved,
       v.note,
       v.at,
       pv.name as voter_name,
       pv.id as voter_id
  from pipeline_vote v
  join pipeline_voter pv on pv.id = v.voter_id;

comment on table candidate_pipeline is
  'En person i en roll. unique (person_id, role_label) - samma person kan ha flera roller.';
comment on column candidate_pipeline.role_label is 'Fria rollnamn t.ex. "Backend-utvecklare". Ingen koppling till job_profile.';
comment on column candidate_pipeline.source is 'Sokvag: var kandidaten hittades.';
comment on column candidate_pipeline.drop_reason is 'Varfor kandidaten forsvann - fritext.';
comment on table pipeline_event is 'Stage-historik. Loggar varje flytt med vem, nar och varfor.';
comment on table pipeline_vote is 'Roster pa granskningskort. En anstalld och en grundare per kort.';
comment on table planner_card is 'Kort fran Teams/Planner-listan "Rekrytering". Importeras via CSV tills Graph-behorighet finns.';
comment on function fn_match_person is 'Matchar ett namn (och valfritt organisation) mot personregistret. Returnerar bast matchning over triskeln 0.75.';
