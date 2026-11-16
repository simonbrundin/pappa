/**
 * Hjälpare för "schemat saknas"-fel.
 *
 * Nya tabeller (pipeline, planner) måste appliceras med `npm run db:migrate`
 * innan appen kan läsa dem. Utan det här svaret surfar råa postgres-fel
 * ("relation candidate_pipeline does not exist") som ett 500 utan att säga
 * vad som faktiskt ska göras.
 */
export function isMissingSchema(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  if (e?.code !== '42P01' && e?.code !== '42703') return false
  const message = e.message ?? ''
  return (
    message.includes('candidate_pipeline') ||
    message.includes('pipeline_voter') ||
    message.includes('pipeline_event') ||
    message.includes('pipeline_vote') ||
    message.includes('planner_card') ||
    message.includes('v_pipeline_board')
  )
}

/** 503 med en instruktion, i stället för ett kryptiskt 500. */
export function throwMissingSchema(): never {
  throw createError({
    statusCode: 503,
    statusMessage: 'Schemat saknas',
    message:
      'Pipeline-tabellerna finns inte i databasen än. Kör "npm run db:migrate" i repot och ladda om sidan.',
  })
}
