-- ============================================================================
-- Test: dubblettsammanslagning (fn_merge_people)
--
-- Körs i en transaktion som rullas tillbaka - testpersonerna finns aldrig
-- i produktionsdatabasen:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test_merge.sql
--
-- Testet fäller med undantag (och avbryter med ON_ERROR_STOP) om något
-- beteende avviker från det som dokumenteras nedan.
-- ============================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Testdata: två poster som antas vara samma person
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid;
  v_b uuid;
  v_src_a uuid;
  v_src_b uuid;
  v_comp int;
  v_org uuid;
begin
  insert into organization (name, normalized_name, kind)
  values ('Testbolaget AB', 'testbolaget ab', 'consultancy')
  returning id into v_org;

  insert into source (url, title, kind)
  values ('https://example.com/a', ' källa A', 'other')
  returning id into v_src_a;
  insert into source (url, title, kind)
  values ('https://example.com/b', 'källa B', 'other')
  returning id into v_src_b;

  insert into competence (tag, category)
  values ('test_tag_a', 'backend')
  on conflict (tag) do update set category = 'backend'
  returning id into v_comp;

  -- A: har källa A, kompetens A, en aktuell anställning UTAN ref (legacy)
  insert into person (external_id, full_name, normalized_name, organization_id,
                      title, it_experience_years, it_experience_basis)
  values ('test-merge-a', 'Test Testsson', 'test testsson', v_org,
          'Konsult', 5, 'explicit')
  returning id into v_a;

  insert into person_source (person_id, source_id) values (v_a, v_src_a);
  insert into person_competence (person_id, competence_id) values (v_a, v_comp);
  insert into person_employment (person_id, organization_id, title, is_current, note)
  values (v_a, v_org, 'Konsult', true, 'legacy-rad');

  -- B: har källa B, samma kompetens, e-post, och en KURATERAD aktuell rad
  insert into person (external_id, full_name, normalized_name, organization_id,
                      title, email, it_experience_years, it_experience_basis)
  values ('test-merge-b', 'Test Testson', 'test testson', v_org,
          'Senior konsult', 'test@example.com', 12, 'explicit')
  returning id into v_b;

  insert into person_source (person_id, source_id) values (v_b, v_src_b);
  insert into person_competence (person_id, competence_id) values (v_b, v_comp);
  insert into person_employment (person_id, organization_id, title, is_current, ref, note)
  values (v_b, v_org, 'Senior konsult', true, 'test-merge-b-kuraterad', 'kuraterad rad');
end $$;

-- ---------------------------------------------------------------------------
-- 1. Sammanslagningen flyttar kopplingar och raderar den dubblerade posten
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid;
  v_b uuid;
  v_summary jsonb;
  v_sources int;
  v_competences int;
  v_employments int;
  v_current int;
  v_email text;
  v_title text;
  v_years int;
  v_basis text;
  v_merges int;
  v_audit int;
begin
  select id into v_a from person where external_id = 'test-merge-a';
  select id into v_b from person where external_id = 'test-merge-b';

  v_summary := fn_merge_people(v_a, v_b, 'test');

  -- Den raderade posten finns inte kvar
  if exists (select 1 from person where id = v_b) then
    raise exception 'FEL: den dubblerade posten finns kvar';
  end if;

  -- Båda källorna, kompetensen och anställningsraderna finns på den som behålls
  select count(*) into v_sources from person_source where person_id = v_a;
  if v_sources <> 2 then
    raise exception 'FEL: förväntade 2 källor, fick %', v_sources;
  end if;

  select count(*) into v_competences from person_competence where person_id = v_a;
  if v_competences <> 1 then
    raise exception 'FEL: förväntade 1 kompetens, fick %', v_competences;
  end if;

  select count(*) into v_employments from person_employment where person_id = v_a;
  if v_employments <> 2 then
    raise exception 'FEL: förväntade 2 anställningsrader, fick %', v_employments;
  end if;

  -- Högst EN aktuell rad: den kuraterade (ref is not null) vinner
  select count(*) into v_current from person_employment
   where person_id = v_a and is_current;
  if v_current <> 1 then
    raise exception 'FEL: förväntade exakt 1 aktuell anställningsrad, fick %', v_current;
  end if;
  if not exists (
    select 1 from person_employment
     where person_id = v_a and is_current and ref = 'test-merge-b-kuraterad'
  ) then
    raise exception 'FEL: den kuraterade raden skulle vinna över legacy-raden';
  end if;

  -- Tomma fält fylls från den raderade posten, befintliga skrivs inte över
  select email into v_email from person where id = v_a;
  if v_email <> 'test@example.com' then
    raise exception 'FEL: e-post fylldes inte från den raderade posten (%s)', v_email;
  end if;
  select title into v_title from person where id = v_a;
  if v_title <> 'Konsult' then
    raise exception 'FEL: befintlig titel skrevs över (%s)', v_title;
  end if;

  -- Erfarenhet: explicit vinner, men det största värdet används
  select it_experience_years, it_experience_basis into v_years, v_basis
    from person where id = v_a;
  if v_years <> 12 then
    raise exception 'FEL: fel erfarenhetsvärde (%s)', v_years;
  end if;
  if v_basis <> 'explicit' then
    raise exception 'FEL: fel erfarenhetsgrund (%s)', v_basis;
  end if;

  -- Sammanslagningen är registrerad så att importen inte skapar tillbaka posten
  select count(*) into v_merges from person_merge
   where dropped_external_id = 'test-merge-b' and keep_external_id = 'test-merge-a';
  if v_merges <> 1 then
    raise exception 'FEL: person_merge saknar registreringen';
  end if;

  -- Spår i audit_log
  select count(*) into v_audit from audit_log
   where action = 'merge_person' and row_id = 'test-merge-b';
  if v_audit <> 1 then
    raise exception 'FEL: audit_log saknar spåret';
  end if;

  -- Sammanfattningen ska rapportera vad som flyttades
  if (v_summary ->> 'sources_moved')::int <> 1 then
    raise exception 'FEL: fel antal flyttade källor i sammanfattningen';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Skydd mot felaktiga anrop
-- ---------------------------------------------------------------------------
do $$
declare
  v_a uuid;
begin
  select id into v_a from person where external_id = 'test-merge-a';

  -- Samma post mot sig själv ska avvisas
  begin
    perform fn_merge_people(v_a, v_a, 'test');
    raise exception 'FEL: samma post kunde slås ihop med sig själv';
  exception when others then
    if sqlerrm not like 'Kan inte slå ihop%' then
      raise;
    end if;
  end;

  -- Okänd post ska avvisas
  begin
    perform fn_merge_people(v_a, '00000000-0000-0000-0000-000000000000'::uuid, 'test');
    raise exception 'FEL: okänd post accepterades';
  exception when others then
    if sqlerrm not like 'Posten som ska tas bort%' then
      raise;
    end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Dubblettkandidater: BÅDE förnamn och efternamn måste stämma
--
--    Negativa fall (får INTE vara starka kandidater):
--      * gemensamt förnamn, olika efternamn  ("Mikael Gidlund"/"Mikael Nordlund")
--      * gemensamt efternamn, olika förnamn ("Gert Söderberg"/"Robert Söderberg")
--
--    Positiva fall (ska vara starka kandidater):
--      * identiskt namn
--      * samma e-post
--      * samma telefon
--      * prefix i efternamnet ("Anna Lind"/"Anna Lindqvist")
--      * 1-3 tecken fel i efternamnet ("Jonatan"/"Jonathan" + samma efternamn)
-- ---------------------------------------------------------------------------
do $$
declare
  v_count int;
begin
  insert into person (external_id, full_name, normalized_name)
  values ('test-dup-1', 'Kandidat Ett', 'kandidat ett')
  on conflict do nothing;
  insert into person (external_id, full_name, normalized_name)
  values ('test-dup-2', 'Kandidat Etta', 'kandidat etta')
  on conflict do nothing;

  -- "Kandidat Ett"/"Kandidat Etta": båda delarna stämmer (near) -> stark
  select count(*) into v_count
    from fn_duplicate_candidates(0.45, false)
   where not weak
     and ((name_a = 'Kandidat Ett' and name_b = 'Kandidat Etta')
       or (name_a = 'Kandidat Etta' and name_b = 'Kandidat Ett'));
  if v_count < 1 then
    raise exception 'FEL: testparet hittades inte av fn_duplicate_candidates';
  end if;
end $$;

-- Negativa fall: ett gemensamt ord räcker inte
do $$
declare
  v_pairs int;
  v_weak int;
  v_gidlund uuid;
  v_nordlund uuid;
begin
  -- Påhittade namn som INTE finns i databasen, så att testet inte
  -- kolliderar med verkliga personer.
  insert into person (external_id, full_name, normalized_name)
  values ('test-neg-1', 'Negativtestgiven Zzzlund', 'negativtestgiven zzzlund')
  on conflict do nothing;
  insert into person (external_id, full_name, normalized_name)
  values ('test-neg-2', 'Negativtestgiven Yyzlund', 'negativtestgiven yyzlund')
  on conflict do nothing;
  insert into person (external_id, full_name, normalized_name)
  values ('test-neg-3', 'Zzz Personnamn', 'zzz personnamn')
  on conflict do nothing;
  insert into person (external_id, full_name, normalized_name)
  values ('test-neg-4', 'Yyz Personnamn', 'yyz personnamn')
  on conflict do nothing;

  -- Inget av de negativa paren får vara en stark kandidat
  select count(*) into v_pairs
    from fn_duplicate_candidates(0.45, false)
   where not weak
     and (name_a in ('Negativtestgiven Zzzlund','Negativtestgiven Yyzlund','Zzz Personnamn','Yyz Personnamn')
       or name_b in ('Negativtestgiven Zzzlund','Negativtestgiven Yyzlund','Zzz Personnamn','Yyz Personnamn'));
  if v_pairs > 0 then
    raise exception 'FEL: % par med bara ett gemensamt ord klassades som dubblett', v_pairs;
  end if;

  -- De ska ändå FÖRESLÅS som svaga par, så att människan kan markera dem
  select count(*) into v_weak
    from fn_duplicate_candidates(0.45, true)
   where weak
     and ((name_a = 'Negativtestgiven Zzzlund' and name_b = 'Negativtestgiven Yyzlund')
       or (name_a = 'Negativtestgiven Yyzlund' and name_b = 'Negativtestgiven Zzzlund')
       or (name_a = 'Zzz Personnamn' and name_b = 'Yyz Personnamn')
       or (name_a = 'Yyz Personnamn' and name_b = 'Zzz Personnamn'));
  if v_weak < 2 then
    raise exception 'FEL: förväntade minst 2 svaga par, fick %', v_weak;
  end if;

  -- Det riktiga exemplet: "Mikael Gidlund"/"Mikael Nordlund" får inte vara
  -- en stark kandidat - de har bara ett gemensamt förnamn.
  select id into v_gidlund from person where full_name = 'Mikael Gidlund' limit 1;
  select id into v_nordlund from person where full_name = 'Mikael Nordlund' limit 1;
  if v_gidlund is not null and v_nordlund is not null then
    select count(*) into v_pairs
      from fn_duplicate_candidates(0.45, false)
     where not weak
       and ((id_a = v_gidlund and id_b = v_nordlund)
         or (id_a = v_nordlund and id_b = v_gidlund));
    if v_pairs > 0 then
      raise exception 'FEL: Mikael Gidlund/Mikael Nordlund klassades som dubblett';
    end if;
  end if;
end $$;

-- Positiva fall: identiskt namn, samma e-post, samma telefon, prefix
do $$
declare
  v_count int;
  v_id_a uuid;
  v_id_b uuid;
begin
  insert into person (external_id, full_name, normalized_name)
  values ('test-pos-1', 'Dott Testsson', 'dott testsson')
  on conflict do nothing;
  insert into person (external_id, full_name, normalized_name)
  values ('test-pos-2', 'Dott Testsson', 'dott testsson')
  on conflict do nothing;
  insert into person (external_id, full_name, normalized_name, email)
  values ('test-pos-3', 'Mail Testsson', 'mail testsson', 'test-merge@example.com')
  on conflict do nothing;
  insert into person (external_id, full_name, normalized_name, email)
  values ('test-pos-4', 'Mejl Testsson', 'mejl testsson', 'test-merge@example.com')
  on conflict do nothing;
  insert into person (external_id, full_name, normalized_name, phone)
  values ('test-pos-5', 'Tele Testsson', 'tele testsson', '+46123456789')
  on conflict do nothing;
  insert into person (external_id, full_name, normalized_name, phone)
  values ('test-pos-6', 'Telefon Testsson', 'telefon testsson', '+46123456789')
  on conflict do nothing;
  insert into person (external_id, full_name, normalized_name)
  values ('test-pos-7', 'Anna Lind', 'anna lind')
  on conflict do nothing;
  insert into person (external_id, full_name, normalized_name)
  values ('test-pos-8', 'Anna Lindqvist', 'anna lindqvist')
  on conflict do nothing;

  -- Identiskt namn
  select count(*) into v_count from fn_duplicate_candidates(0.45, false)
   where not weak and name_a = 'Dott Testsson' and name_b = 'Dott Testsson';
  if v_count < 1 then
    raise exception 'FEL: identiskt namn hittades inte';
  end if;

  -- Samma e-post (ordningen på a/b är inte garanterad)
  select count(*) into v_count from fn_duplicate_candidates(0.45, false)
   where not weak and same_email
     and name_a = 'Mail Testsson' and name_b = 'Mejl Testsson';
  if v_count < 1 then
    select count(*) into v_count from fn_duplicate_candidates(0.45, false)
     where not weak and same_email
       and name_a = 'Mejl Testsson' and name_b = 'Mail Testsson';
  end if;
  if v_count < 1 then
    raise exception 'FEL: samma e-post hittades inte';
  end if;

  -- Samma telefon
  select count(*) into v_count from fn_duplicate_candidates(0.45, false)
   where not weak and same_phone
     and name_a = 'Tele Testsson' and name_b = 'Telefon Testsson';
  if v_count < 1 then
    select count(*) into v_count from fn_duplicate_candidates(0.45, false)
     where not weak and same_phone
       and name_a = 'Telefon Testsson' and name_b = 'Tele Testsson';
  end if;
  if v_count < 1 then
    raise exception 'FEL: samma telefon hittades inte';
  end if;

  -- Prefix i efternamnet
  select count(*) into v_count from fn_duplicate_candidates(0.45, false)
   where not weak and name_a = 'Anna Lind' and name_b = 'Anna Lindqvist';
  if v_count < 1 then
    select count(*) into v_count from fn_duplicate_candidates(0.45, false)
     where not weak and name_a = 'Anna Lindqvist' and name_b = 'Anna Lind';
  end if;
  if v_count < 1 then
    raise exception 'FEL: prefix-matchning hittades inte';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. "Behåll båda" utesluter paret ur kandidatlistan
-- ---------------------------------------------------------------------------
do $$
declare
  v_count int;
  v_id_a uuid;
  v_id_b uuid;
begin
  select id into v_id_a from person where external_id = 'test-neg-1';
  select id into v_id_b from person where external_id = 'test-neg-2';

  insert into duplicate_dismissal (person_a_id, person_b_id, actor, note)
  values (v_id_a, v_id_b, 'test', 'testpar');

  select count(*) into v_count
    from fn_duplicate_candidates(0.45, true)
   where (id_a = v_id_a and id_b = v_id_b) or (id_a = v_id_b and id_b = v_id_a);
  if v_count <> 0 then
    raise exception 'FEL: det markerade paret visas fortfarande';
  end if;
end $$;

rollback;

\echo 'OK: alla tester för dubblettsammanslagning gick igenom (transaktionen rullades tillbaka).'
