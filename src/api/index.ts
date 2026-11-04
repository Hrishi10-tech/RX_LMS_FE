// The shared HTTP client, plus the one feature API service that is imported
// through here. Every other service is imported from its own feature folder
// (`@/features/<feature>/services/<name>.api`); re-exports nothing used were
// removed so this file stops implying they are.
export { client } from './client';
export { usersApi } from '@/features/users/services/users.api';
