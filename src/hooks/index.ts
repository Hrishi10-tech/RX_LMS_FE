// Re-exports cross-cutting hooks + every feature's hook(s).
// Code can use `import { useAuth, useIndents } from '@/hooks'` for convenience,
// or import directly from the hook's file, e.g. '@/features/indents/hooks/useIndents'.
export * from './useAbortOnUnmount';
export * from './useAuth';
export * from './useTheme';
export * from './useSocket';
export * from './useBulkSelection';
export * from './useTableFilters';
export * from './useServerPagination';
export * from './useClientPagination';
export * from './useUnreadNotifications';
export * from './useUnreadMessages';
export * from './useDesktopNotifications';
export * from './useSidebarBadgeCounts';
export * from './useRowDeepLink';
export { useDepartments } from '@/features/departments/hooks/useDepartments';
export { useUsers } from '@/features/users/hooks/useUsers';
export { useInventoryOptions } from '@/features/inventory/hooks/useInventoryOptions';
export type { InventoryOption } from '@/features/inventory/hooks/useInventoryOptions';
export { useRequests } from '@/features/requests/hooks/useRequests';
export { useIndents } from '@/features/indents/hooks/useIndents';
export { useFormBootstrap } from './useFormBootstrap';
