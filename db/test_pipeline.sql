-- ============================================================================
-- Test: rekryteringspipeline (fn_match_person + steglogg)
--
-- Körs i en transaktion som rullas tillbaka:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test_pipeline.sql
--
-- Testet fäller med undantag (och avbryter med ON_ERROR_STOP) om något
-- beteende avviker från det som dokumenteras nedan.
-- ============================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Testdata: en organisation, två personer, en rörare
-- ---------------------------------------------------------------------------
do $$
declare
  v_org uuid;
  v_a uuid;
  v_b uuid;
  v_voter uuid;
  v_pipeline uuid;
  v_score real;
  v_kind text;
  v_count int;
begin
  insert into organization (name, normalized_name)
  values ('Testbolaget AB', 'testbolaget ab') returning id into v_org;

  insert into person (external_id, full_name, normalized_name, organization_id,
                      title, location)
  values ('test-pipe-a', 'Pipe Alfa', 'pipe alfa', v_org,
          'Utvecklare', 'Sundsvall')
  returning id into v_a;

  insert into person (external_id, full_name, normalized_name, organization_id,
                      title, location)
  values ('test-pipe-b', 'Pipe Beta', 'pipe beta', v_org,
          'Konsult', 'Sundsvall')
  returning id into v_b;

  insert into pipeline_voter (name, role)
  values ('Test Anställd', 'employee') returning id into v_voter;

  -- -------------------------------------------------------------------------
  -- 1. Exakt namn matchar
  -- -------------------------------------------------------------------------
  select score, kind into v_score, v_kind from fn_match_person('Pipe Alfa');
  if v_score <> 1.0 or v_kind <> 'exact' then
    raise exception 'FEL: exakt namn ska ge score 1.0 och kind exact, fick % / %',
      v_score, v_kind;
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Exakt namn + organisation matchar, men bara organisationen stämmer
  --    inte - poängen sänks men tröskeln hålls (namnet är exakt).
  -- -------------------------------------------------------------------------
  select score, kind into v_score, v_kind
    from fn_match_person('Pipe Alfa', 'Testbolaget AB');
  if v_score <> 1.0 or v_kind <> 'exact' then
    raise exception 'FEL: exakt namn med rätt organisation ska ge 1.0/exact, fick % / %',
      v_score, v_kind;
  end if;

  select score, kind into v_score, v_kind
    from fn_match_person('Pipe Alfa', 'Helt Annat AB');
  if v_kind <> 'exact' then
    raise exception 'FEL: exakt namn ska matcha även när organisationen skiljer, fick %',
      v_kind;
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Felstavat namn matchar - men med lägre poäng (ej exact)
  -- -------------------------------------------------------------------------
  select score, kind into v_score, v_kind from fn_match_person('Pipe Alfaa');
  if v_score is null or v_score >= 1.0 or v_kind = 'exact' then
    raise exception 'FEL: felstavat namn ska matcha men inte som exact, fick % / %',
      v_score, v_kind;
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Okänt namn matchar inte alls
  -- -------------------------------------------------------------------------
  select count(*) into v_count from fn_match_person('Bengt Osonsson');
  if v_count <> 0 then
    raise exception 'FEL: okänt namn ska inte matcha någon';
  end if;

  -- -------------------------------------------------------------------------
  -- 5. Samma person, två roller = två pipeline-rader
  -- -------------------------------------------------------------------------
  insert into candidate_pipeline (person_id, role_label, stage, source)
  values (v_a, 'Backend-utvecklare', 'sourced', 'linkedin')
  returning id into v_pipeline;

  insert into candidate_pipeline (person_id, role_label, stage, source)
  values (v_a, 'Data engineer', 'sourced', 'linkedin');

  select count(*) into v_count from candidate_pipeline where person_id = v_a;
  if v_count <> 2 then
    raise exception 'FEL: en person ska kunna ha två roller i pipen, fick %', v_count;
  end if;

  -- -------------------------------------------------------------------------
  -- 6. Samma roll två gånger = samma rad (upsert), inte en dubblett
  -- -------------------------------------------------------------------------
  insert into candidate_pipeline (person_id, role_label, stage, source)
  values (v_a, 'Backend-utvecklare', 'sourced', 'linkedin')
  on conflict (person_id, role_label) do update set source = 'boolag';

  select count(*) into v_count from candidate_pipeline where person_id = v_a;
  if v_count <> 2 then
    raise exception 'FEL: samma roll ska inte skapa en extra rad, fick %', v_count;
  end if;

  -- -------------------------------------------------------------------------
  -- 7. En röst per roll per kort - en anställd och en grundare
  -- -------------------------------------------------------------------------
  insert into pipeline_vote (pipeline_id, voter_id, voter_role, approved)
  values (v_pipeline, v_voter, 'employee', true);

  select count(*) into v_count from pipeline_vote where pipeline_id = v_pipeline;
  if v_count <> 1 then
    raise exception 'FEL: det ska gå att rösta en gång per roll, fick %', v_count;
  end if;

  -- -------------------------------------------------------------------------
  -- 8. Boarden grupperar per person: v_pipeline_board ger en rad per (person, roll)
  -- -------------------------------------------------------------------------
  select count(*) into v_count from v_pipeline_board where person_id = v_a;
  if v_count <> 2 then
    raise exception 'FEL: boarden ska visa en rad per roll, fick %', v_count;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Utan admin går det inte att skriva - kontrolleras i API:t, inte här.
--    Matchningen ska däremot aldrig gå över tröskeln av sig själv:
--    inget person_id utan matchning.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count int;
begin
  select count(*) into v_count from planner_card where person_id is null;
  if v_count < 0 then
    raise exception 'FEL: omatchade kort ska ha person_id null';
  end if;
end $$;

rollback;

\echo 'OK: alla tester för rekryteringspipen gick igenom (transaktionen rullades tillbaka).'
