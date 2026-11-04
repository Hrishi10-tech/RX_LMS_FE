import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { User } from '@/types';
import { queryKeys } from '@/lib/queryKeys';
import { usersApi } from '../services/users.api';

export const useUsers = () => {
  const [enabled, setEnabled] = useState(false);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.users.list(),
    queryFn: () => usersApi.getAll(),
    enabled,
  });

  const fetchUsers = useCallback(() => {
    setEnabled(true);
    return queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: (data: any) => usersApi.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => usersApi.update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
  });

  const promoteMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'MANAGER' | 'ADMIN' }) => usersApi.promote(id, role),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
  });

  const demoteMutation = useMutation({
    mutationFn: ({ id, role, reassignToManagerId }: { id: string; role: 'MANAGER' | 'USER'; reassignToManagerId?: string | null }) =>
      usersApi.demote(id, role, reassignToManagerId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
  });

  return {
    users: (query.data ?? []) as User[],
    isLoading: query.isLoading || query.isFetching,
    error: query.error ? (query.error as Error).message : null,
    fetchUsers,
    createUser: (data: any) => createMutation.mutateAsync(data),
    updateUser: (id: string, data: any) => updateMutation.mutateAsync({ id, data }),
    promoteUser: (id: string, role: 'MANAGER' | 'ADMIN') => promoteMutation.mutateAsync({ id, role }),
    demoteUser: (id: string, role: 'MANAGER' | 'USER', reassignToManagerId?: string | null) =>
      demoteMutation.mutateAsync({ id, role, reassignToManagerId }),
  };
};
