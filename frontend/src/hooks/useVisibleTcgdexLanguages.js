import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getTcgdexFilterLanguages } from '../api/client'

export function useVisibleTcgdexLanguages() {
  const { data, isLoading } = useQuery({
    queryKey: ['tcgdex-filter-languages'],
    queryFn: () => getTcgdexFilterLanguages(),
  })

  return useMemo(() => {
    const languages = data?.languages || []
    return Object.assign([...languages], { isLoading: isLoading && !data })
  }, [data, isLoading])
}
