import { useEffect, useState } from 'react';
import { cachedGet, extractErrorMessage } from '@/lib';
import { useToast } from '../context';

/**
 * The reference data every request/indent form needs: projects, departments,
 * and the user directory.
 *
 * Extracted because RequestForm and IndentForm carried byte-identical copies of
 * this — the same three fetches, the same `?.data || x || []` unwrapping, and
 * the same bare `catch {}`. Two consequences, and the second is the reason this
 * is a hook rather than a tidy-up:
 *
 *   - A failed load rendered both forms with EMPTY Project, Department and
 *     Responsible-Person dropdowns and no error at all. The form looked fine
 *     and simply had nothing to choose from, which reads as "the data is gone"
 *     rather than "the request failed".
 *   - Duplicated, so fixing one would never have reached the other.
 *
 * `cachedGet` dedups and caches across modal opens: projects, departments and
 * the directory change rarely, and refetching them on every form open was
 * generating most of these pages' API traffic.
 */
export const useFormBootstrap = () => {
  const [projects, setProjects] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [usersDirectory, setUsersDirectory] = useState<any[]>([]);
  const [failed, setFailed] = useState(false);
  const { addToast } = useToast();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [projRes, deptRes, usersRes] = await Promise.all([
          cachedGet<any>('/projects'),
          cachedGet<any>('/departments'),
          cachedGet<any>('/users/directory'),
        ]);
        if (!alive) return;
        setProjects(projRes?.data || projRes || []);
        setDepartments(deptRes?.data || deptRes || []);
        setUsersDirectory(usersRes?.data || usersRes || []);
        setFailed(false);
      } catch (e: any) {
        if (!alive) return;
        // Say so. An empty dropdown with no message is indistinguishable from
        // "there are none", and the user has no reason to retry.
        setFailed(true);
        addToast(
          extractErrorMessage(e, "Couldn't load projects, departments and people — the dropdowns below will be empty. Close and reopen to retry."),
          'error',
        );
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { projects, departments, usersDirectory, failed };
};
