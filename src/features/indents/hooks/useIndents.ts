import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Indent } from '@/types';
import { queryKeys } from '@/lib/queryKeys';
import { indentsApi } from '../services/indents.api';

export const useIndents = () => {
  const [params, setParams] = useState<Record<string, any> | undefined>();

  const query = useQuery({
    queryKey: queryKeys.indents.list(params),
    queryFn: () => indentsApi.getAll(params),
    enabled: params !== undefined,
  });

  const fetchIndents = useCallback((p?: Record<string, any>) => {
    setParams(p ?? {});
  }, []);

  return {
    indents: (query.data ?? []) as Indent[],
    isLoading: query.isLoading || query.isFetching,
    error: query.error ? (query.error as Error).message : null,
    fetchIndents,
  };
};
