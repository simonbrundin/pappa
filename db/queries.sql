-- ============================================================================
-- pappa - driftfrågor
-- ============================================================================

-- 1. Dubblettkoll innan en ny person sparas
--    Exempel: 'Tommy Gustafson' (stavfel) mot 'Aderian GDM'
-- select * from fn_find_duplicates('Tommy Gustafson', 'Aderian GDM', 0.6);

-- 2. Coverage / kvalitet
select * from v_coverage;

-- 3. Personer i en viss organisation
-- select full_name, title, seniority, location, confidence
-- from v_people_full where organization ilike '%knowit%';

-- 4. Sök på kompetens (flera taggar samtidigt)
-- select full_name, organization, competences
-- from v_people_full
-- where competences @> array['dotnet'] and competences @> array['azure'];

-- 5. Export för Teams-bevakningslistan (CSV)
--    \copy (select * from v_watchlist_export order by organization, full_name) to 'export.csv' with csv header

-- 6. Export av alla personer med källa (för granskning)
-- select external_id, full_name, title, organization, location, confidence, source_urls
-- from v_people_full order by organization, full_name;

-- 7. GDPR: vem ska raderas?
select external_id, full_name, retention_until, contact_state, email
from person
where retention_until is not null and retention_until < current_date
order by retention_until;

-- 8. GDPR: kör gallring
-- select fn_purge_expired_personal_data('cron');

-- 9. Raderingsbegäran: är alla begärda raderade?
select id, kind, subject_ref, state, received_at, due_at, handled_at
from dsr_request order by received_at desc;

-- 10. Har vi missat Art. 14-information?
select p.full_name, c.occurred_at, c.channel, c.art14_sent
from contact_event c join person p on p.id = c.person_id
where c.art14_sent = false
order by c.occurred_at desc;

-- 11. Verifiera positioner som är äldre än 12 månader (data som kan vara stale)
--     Kör denna innan kontakt - källans ålder avgör.
select p.full_name, o.name as org, e.title, s.url, s.accessed_at,
       (current_date - s.accessed_at) as days_old
from person_employment e
join person p on p.id = e.person_id
left join organization o on o.id = e.organization_id
left join source s on s.id = e.source_id
where e.is_current and (s.accessed_at is null or s.accessed_at < current_date - 365)
order by days_old desc nulls last;

-- 12. organisationsfördelning
select organization, count(*) as antal
from v_people_full group by 1 order by 2 desc;

-- 13. Vilka källor har vi använt?
select kind, count(*) as antal, min(accessed_at) as äldsta, max(accessed_at) as nyaste
from source group by 1 order by 2 desc;

-- 14. Dubblett i organisationsnamn (samma bolag, olika stavning)
select a.name, b.name, round(similarity(a.normalized_name, b.normalized_name)::numeric, 3) as sim
from organization a join organization b on a.id < b.id
where similarity(a.normalized_name, b.normalized_name) > 0.6
order by sim desc;

-- 15. Erfarenhet (år i IT) - grund för värdet
--     it_experience_basis = explicit (angivet i YAML) | notes (ur fritext)
--                         | seniority (undre gräns från rollnivå)
select it_experience_basis, count(*) as antal,
       min(it_experience_years) as minsta, max(it_experience_years) as största
from person group by 1 order by 2 desc;

-- 16. Vem uppfyller "minst 3 år i IT"? Okänd erfarenhet räknas inte in.
select full_name, title, organization, it_experience_years, it_experience_basis
from v_people_full
where it_experience_years >= 3
order by it_experience_years desc nulls last, full_name;

-- 17. CV per person - var, vad, hur länge
select full_name, organization, title, valid_from, valid_to, months, is_current, confidence
from v_cv order by full_name, is_current desc, valid_from desc nulls last;

-- 18. Dokumenterad anställningstid (månader) - den siffra som går att belägga
select full_name, fn_documented_experience(id) as manader,
       round(fn_documented_experience(id) / 12.0, 1) as ar,
       it_experience_years, it_experience_basis
from v_people_full
where fn_documented_experience(id) > 0
order by manader desc;

-- 19. Datakvalitet: anställningsrader UTAN källa (ska vara 0)
select count(*) as utan_kalla from v_cv where source_url is null;

-- 20. Datakvalitet: fler än en aktuell rad per person (ska vara 0)
select full_name, count(*) as aktuella
from v_cv where is_current group by 1 having count(*) > 1;

-- 21. Datakvalitet: överlappande perioder (konsult kan haft parallella roller)
select a.full_name, a.organization as org_a, b.organization as org_b,
       a.valid_from, a.valid_to, b.valid_from, b.valid_to
from v_cv a join v_cv b
  on a.person_id = b.person_id and a.employment_id < b.employment_id
where a.valid_from is not null and b.valid_from is not null
  and a.valid_from < coalesce(b.valid_to, current_date)
  and b.valid_from < coalesce(a.valid_to, current_date);

-- 22. Vem har varit var - "vilken stack på CGI?"
select full_name, organization, title, array_to_string(stack, ', ') as stack,
       valid_from, valid_to
from v_cv
where stack <> '{}' and valid_from is not null
order by full_name;

-- 23. Arbetsgivare med flest anställda i databasen
select o.name, count(distinct p.id) as antal_personer,
       count(distinct e.id) as antal_anstallda
from organization o
join person_employment e on e.organization_id = o.id
join person p on p.id = e.person_id
group by 1 order by 2 desc;

-- 24. Dubblettkandidater - par som bör granskas av en människa.
--     OBS: förslag, inte sanning. Släktingar i samma bolag hamnar här.
select signal, name_a, name_b, round(similarity::numeric, 2) as namnlikhet,
       org_a, org_b, shared_competences
from fn_duplicate_candidates(0.45, false)
where not weak
order by score desc;

-- 25. Sammanslagna dubbletter - vad har slagits ihop och när?
select dropped_external_id, dropped_name, keep_external_id, actor, merged_at
from person_merge
order by merged_at desc;

-- 26. Datakvalitet: sammanslagna poster som fortfarande finns kvar (ska vara 0)
--     En sammanslagen post ska vara raderad - annars har den kommit tillbaka
--     genom någon annan väg.
select p.external_id, p.full_name
from person p
join person_merge m on m.dropped_external_id = p.external_id;

-- 27. Datakvalitet: personer utan källa (ska vara 0)
select p.external_id, p.full_name
from person p
where not exists (select 1 from person_source ps where ps.person_id = p.id);

-- ===========================================================================
-- Uppdragsmatchning
-- ===========================================================================

-- 28. Rankad kandidatlista mot en kravprofil.
--     Sätt PROFIL_ID till profilens id (se fråga 30).
--     Poängen är alltid delpoäng + förklaring - läs alltid med.
--     \set PROFIL_ID '...'
select score, eligible, full_name, title, organization,
       must_covered || '/' || must_total as must,
       nice_covered || '/' || nice_total as nice,
       experience_basis, experience_years, seniority, location
from fn_match_candidates(:'PROFIL_ID'::uuid);

-- 29. Förklaringen - vad poängen egentligen bygger på.
--     Det här är raden som ska läsas innan någon kontaktas.
select full_name, score, array_to_string(explanation, E'\n  - ') as forklaring
from fn_match_candidates(:'PROFIL_ID'::uuid)
where eligible
order by score desc
limit 20;

-- 30. Vilka profiler finns? Kopiera id till fråga 28.
select id, slug, title, client_name,
       must_have::text, min_must_have, nice_to_have::text,
       min_seniority, min_experience_years, required_location,
       accepted_locations::text, required_languages::text,
       weights
from job_profile
order by created_at;

-- 31. Must-have-täckning: vem täcker vad? Används för att se om ett
--     krav är för snävt - om ingen täcker mer än 1 av 3 är kravet för hårt.
select m.tag,
       count(distinct pc.person_id)::int as personer_med_taggen
from job_profile jp
cross join lateral unnest(jp.must_have) as m(tag)
left join person_competence pc
  on pc.competence_id = (select id from competence where tag = m.tag)
group by m.tag
order by personer_med_taggen desc;

-- 32. Datakonfidens i urvalet: hur mycket av bilden är belagd?
--     documented = daterad anställningshistorik, explicit = angivet,
--     seniority = gissat ur rollnivå.
select it_experience_basis, count(*)::int as personer,
       count(*) filter (where fn_documented_experience(id) > 0)::int as med_daterad_historik
from person
group by 1
order by 2 desc;

-- 33. Hur påverkas poängen av vikterna? Kör om fråga 28 med en annan
--     viktfördelning genom att ändra weights i profilen:
--     update job_profile set weights = '{"must_have":60, ...}'::jsonb where id = ...;
--     Jämför ordningen mot fråga 28 - en stor poängskillnad utan
--     skillnad i täckning betyder att vikten styr listan, inte matchningen.
