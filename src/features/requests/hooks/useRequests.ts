import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ComponentRequest } from '@/types';
import { queryKeys } from '@/lib/queryKeys';
import { requestsApi } from '../services/requests.api';

export const useRequests = () => {
  const [params, setParams] = useState<Record<string, any> | undefined>();

  const query = useQuery({
    queryKey: queryKeys.requests.list(params),
    queryFn: () => requestsApi.getAll(params),
    enabled: params !== undefined,
  });

  const fetchRequests = useCallback((p?: Record<string, any>) => {
    setParams(p ?? {});
  }, []);

  return {
    requests: (query.data ?? []) as ComponentRequest[],
    isLoading: query.isLoading || query.isFetching,
    error: query.error ? (query.error as Error).message : null,
    fetchRequests,
  };
};
