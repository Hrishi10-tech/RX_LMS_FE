import { IndentApprovalMode } from '@/types';

/**
 * The two sign-off chains, described by what they mean rather than by their
 * enum names. "MANAGER_REQUIRED" tells you nothing about who waits for whom.
 *
 * Shared, because the labels are now an answer the departments table gives at
 * a glance — two spellings of the same choice between the table and anywhere
 * else is its own bug report.
 */
/**
 * The setting is a question about the MANAGER's signature — the department
 * admin signs either way. It was once worded as a choice between two
 * signatories ("Manager or Admin" / "Manager, then Admin"), which was both
 * wrong and too long to sit in a table row.
 *
 * `short` is what the row's toggle shows; `label` is the full phrase, used
 * wherever there is room to say it properly (the toast that confirms a save).
 */
export const APPROVAL_MODES: { value: IndentApprovalMode; label: string; short: string; detail: string }[] = [
  {
    value: 'MANAGER_OPTIONAL',
    label: 'Manager optional',
    short: 'Optional',
    detail:
      'The manager is asked first and it sits in their queue, but the admin is not held up. '
      + 'An admin signing ahead of them is warned, can go ahead, and the manager is told.',
  },
  {
    value: 'MANAGER_REQUIRED',
    label: 'Manager required',
    short: 'Required',
    detail:
      'The manager signs first. The admin cannot approve until they have — there is no way past it, '
      + 'except when the requester has no manager at all.',
  },
];

export const DEFAULT_APPROVAL_MODE: IndentApprovalMode = 'MANAGER_OPTIONAL';

export const approvalModeLabel = (mode?: IndentApprovalMode) =>
  APPROVAL_MODES.find((m) => m.value === (mode || DEFAULT_APPROVAL_MODE))?.label ?? '';
