import type { PeopleResponse } from '#shared/types/people'

export function usePeople() {
  return useFetch<PeopleResponse>('/api/people', {
    key: 'people',
    default: (): PeopleResponse => ({
      people: [],
      facets: {
        organizations: [],
        competences: [],
        locations: [],
        seniorities: [],
        spokenLanguages: [],
        competenceGroups: {},
      },
      count: 0,
    }),
  })
}
