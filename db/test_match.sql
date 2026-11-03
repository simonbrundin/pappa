-- ============================================================================
-- Test: uppdragsmatchning (fn_match_candidates)
--
-- Körs i en transaktion som rullas tillbaka:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test_match.sql
--
-- Testet fäller med undantag (och avbryter med ON_ERROR_STOP) om något
-- beteende avviker från det som dokumenteras nedan.
-- ============================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Testdata: profil och fyra testpersoner
-- ---------------------------------------------------------------------------
do $$
declare
  v_profile uuid;
  v_a uuid;
  v_b uuid;
  v_c uuid;
  v_d uuid;
  v_comp_dev int;
  v_comp_cloud int;
  v_src uuid;
begin
  select id into v_comp_dev from competence where tag = 'system_development';
  select id into v_comp_cloud from competence where tag = 'cloud';

  insert into source (url, title, kind)
  values ('https://example.com/test-match', 'testkälla', 'other')
  returning id into v_src;

  insert into job_profile
    (title, must_have, min_must_have, nice_to_have, min_seniority,
     min_experience_years, required_location, required_languages)
  values ('Testprofil', array['system_development'], 1,
          array['cloud'], 'senior', 8, 'Sundsvall', array['svenska'])
  returning id into v_profile;

  -- A: har must-have-taggen, senior, rätt ort, dokumenterad historik
  -- A har belagd historik: 10 år daterad anställning, alltså över kravet
  -- på 8 år. D har samma rollnivå men erfarenheten är en gissning ur
  -- rollnivån - därför ska A vinna.
  insert into person (external_id, full_name, normalized_name, location,
                      seniority, it_experience_years, it_experience_basis,
                      data_confidence)
  values ('test-match-a', 'Match Alfa', 'match alfa', 'Sundsvall',
          'senior', 12, 'explicit', 'high')
  returning id into v_a;
  insert into person_competence (person_id, competence_id)
  values (v_a, v_comp_dev);
  insert into person_employment (person_id, title, is_current, ref, source_id,
                                valid_from)
  values (v_a, 'Konsult', true, 'test-match-a-1', v_src,
          current_date - interval '10 years');

  -- B: har must-have-taggen, junior, fel ort
  insert into person (external_id, full_name, normalized_name, location,
                      seniority, it_experience_years, it_experience_basis,
                      data_confidence)
  values ('test-match-b', 'Match Beta', 'match beta', 'Umeå',
          'junior', 1, 'explicit', 'medium')
  returning id into v_b;
  insert into person_competence (person_id, competence_id)
  values (v_b, v_comp_dev);

  -- C: saknar must-have-taggen helt
  insert into person (external_id, full_name, normalized_name, location,
                      seniority, it_experience_years, it_experience_basis,
                      data_confidence)
  values ('test-match-c', 'Match Gamma', 'match gamma', 'Sundsvall',
          'cxo', 25, 'explicit', 'high')
  returning id into v_c;

  -- D: har must-have-taggen, senior, rätt ort, men erfarenheten är
  --    en gissning ur rollnivå
  insert into person (external_id, full_name, normalized_name, location,
                      seniority, it_experience_years, it_experience_basis,
                      data_confidence)
  values ('test-match-d', 'Match Delta', 'match delta', 'Sundsvall',
          'lead', 6, 'seniority', 'high')
  returning id into v_d;
  insert into person_competence (person_id, competence_id)
  values (v_d, v_comp_dev);
end $$;

-- ---------------------------------------------------------------------------
-- 1. En kandidat som täcker must-have är "eligible", en som inte täcker
--    någon must-have är inte det
-- ---------------------------------------------------------------------------
do $$
declare
  v_profile uuid;
  v_a boolean;
  v_c boolean;
  v_covered int;
begin
  select id into v_profile from job_profile where title = 'Testprofil';

  select eligible into v_a from fn_match_candidates(v_profile)
   where full_name = 'Match Alfa';
  if v_a is not true then
    raise exception 'FEL: kandidaten som täcker must-have är inte eligible';
  end if;

  select eligible into v_c from fn_match_candidates(v_profile)
   where full_name = 'Match Gamma';
  if v_c is not false then
    raise exception 'FEL: kandidaten utan must-have är eligible';
  end if;

  -- Täckningen ska räknas rätt
  select must_covered into v_covered from fn_match_candidates(v_profile)
   where full_name = 'Match Alfa';
  if v_covered <> 1 then
    raise exception 'FEL: fel must-täckning (%s)', v_covered;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Dokumenterad erfarenhet slår gissad erfarenhet vid samma profil
--    (A har belagd historik, D har samma rollnivå men gissad erfarenhet)
-- ---------------------------------------------------------------------------
do $$
declare
  v_profile uuid;
  v_a numeric;
  v_d numeric;
  v_basis_a text;
  v_basis_d text;
begin
  select id into v_profile from job_profile where title = 'Testprofil';

  select score, experience_basis into v_a, v_basis_a
    from fn_match_candidates(v_profile) where full_name = 'Match Alfa';
  select score, experience_basis into v_d, v_basis_d
    from fn_match_candidates(v_profile) where full_name = 'Match Delta';

  if v_basis_a <> 'documented' then
    raise exception 'FEL: A ska ha dokumenterad erfarenhet (%s)', v_basis_a;
  end if;
  if v_basis_d <> 'seniority' then
    raise exception 'FEL: D ska ha uppskattad erfarenhet (%s)', v_basis_d;
  end if;
  if v_a <= v_d then
    raise exception 'FEL: dokumenterad erfarenhet ska slå uppskattad (%s vs %s)', v_a, v_d;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Delpoängarna ligger i rätt intervall och orten straffas
-- ---------------------------------------------------------------------------
do $$
declare
  v_profile uuid;
  v_b numeric;
  v_loc numeric;
  v_sen numeric;
  v_lang numeric;
begin
  select id into v_profile from job_profile where title = 'Testprofil';

  select location_score, seniority_score, language_score
    into v_loc, v_sen, v_lang
    from fn_match_candidates(v_profile) where full_name = 'Match Beta';

  if v_loc <> 0 then
    raise exception 'FEL: fel ort i orten ska ge 0 poäng, fick %s', v_loc;
  end if;
  if v_sen >= 100 then
    raise exception 'FEL: junior ska inte nå kravnivån senior (%s)', v_sen;
  end if;
  if v_lang <> 50 then
    raise exception 'FEL: saknad språkdata ska ge neutrala 50, fick %s', v_lang;
  end if;

  -- Poängen ska ligga i 0-100
  if exists (select 1 from fn_match_candidates(v_profile)
              where score < 0 or score > 100) then
    raise exception 'FEL: poäng utanför 0-100';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Vikterna styr poängen: samma person, olika vikter -> olika poäng
-- ---------------------------------------------------------------------------
do $$
declare
  v_profile uuid;
  v_normal numeric;
  v_must_heavy numeric;
begin
  select id into v_profile from job_profile where title = 'Testprofil';

  select score into v_normal from fn_match_candidates(v_profile)
   where full_name = 'Match Alfa';

  update job_profile set weights = '{"must_have":80,"nice_to_have":5,"experience":5,
                                     "seniority":5,"location":2,"language":1,
                                     "availability":1,"confidence":1}'::jsonb
   where id = v_profile;

  select score into v_must_heavy from fn_match_candidates(v_profile)
   where full_name = 'Match Alfa';

  if v_normal = v_must_heavy then
    raise exception 'FEL: vikterna påverkar inte poängen';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. En profil utan krav ger ingen poäng (och ingen krasch)
-- ---------------------------------------------------------------------------
do $$
declare
  v_empty uuid;
  v_count int;
begin
  insert into job_profile (title) values ('Tom profil') returning id into v_empty;

  select count(*) into v_count from fn_match_candidates(v_empty);
  if v_count <> 0 then
    raise exception 'FEL: en tom profil ska inte matcha någon';
  end if;
end $$;

rollback;

\echo 'OK: alla tester för uppdragsmatchning gick igenom (transaktionen rullades tillbaka).'
