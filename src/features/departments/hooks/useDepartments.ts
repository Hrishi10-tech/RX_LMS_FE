import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Department } from '@/types';
import { queryKeys } from '@/lib/queryKeys';
import { departmentsApi } from '../services/departments.api';

// Build a nested tree from the flat department list. Unlimited depth; any node
// whose parent is missing is treated as a root. Pure — the hook recomputes it
// whenever the list changes, so there's no separate /departments/tree request.
const byName = (a: any, b: any) => String(a.name || '').localeCompare(String(b.name || ''));

const buildTree = (items: Department[]): any[] => {
  const byId = new Map(items.map((d) => [d.id, { ...d, children: [] as any[] }]));
  const roots: any[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // Sorted here as well as on the server. The tree otherwise inherits whatever
  // order the rows arrived in, and an UPDATE moves a row in Postgres — which
  // made the list jump every time someone changed a department's approval
  // mode. One sort on each side means neither can reintroduce it alone.
  roots.sort(byName);
  for (const node of byId.values()) node.children.sort(byName);
  return roots;
};

/**
 * Single source of truth: the flat department list (`fetchDepartments`). The
 * hierarchical `tree` is derived from it in-memory — one request, not two — and
 * supports unlimited nesting depth (the old /tree endpoint capped at 3 levels).
 */
export const useDepartments = () => {
  const [listEnabled, setListEnabled] = useState(false);
  const queryClient = useQueryClient();

  const listQuery = useQuery({
    queryKey: queryKeys.departments.list(),
    queryFn: () => departmentsApi.getAll(),
    enabled: listEnabled,
  });

  const fetchDepartments = useCallback(() => {
    setListEnabled(true);
    return queryClient.invalidateQueries({ queryKey: queryKeys.departments.list() });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: ({ name, parentId, indentApprovalMode }: { name: string; parentId?: string; indentApprovalMode?: string }) =>
      departmentsApi.create({ name, parentId, indentApprovalMode }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.departments.all }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, name, parentId, indentApprovalMode }: { id: string; name: string; parentId?: string | null; indentApprovalMode?: string }) =>
      departmentsApi.update(id, { name, parentId, indentApprovalMode }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.departments.all }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => departmentsApi.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.departments.all }),
  });

  const departments = useMemo(() => (listQuery.data ?? []) as Department[], [listQuery.data]);
  const tree = useMemo(() => buildTree(departments), [departments]);

  return {
    departments,
    tree,
    isLoading: listQuery.isLoading || listQuery.isFetching,
    error: listQuery.error ? (listQuery.error as Error).message : null,
    fetchDepartments,
    createDepartment: (name: string, parentId?: string, indentApprovalMode?: string) =>
      createMutation.mutateAsync({ name, parentId, indentApprovalMode }),
    updateDepartment: (id: string, name: string, parentId?: string | null, indentApprovalMode?: string) =>
      updateMutation.mutateAsync({ id, name, parentId, indentApprovalMode }),
    deleteDepartment: (id: string) => deleteMutation.mutateAsync(id),
  };
};
