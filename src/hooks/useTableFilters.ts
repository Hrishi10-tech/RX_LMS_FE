import { useState, useMemo, useCallback } from 'react';
import { useClientPagination } from './useClientPagination';

export type FilterSpec<T> = {
  /** Stable key — used in state, in ColumnFilter `onChange`, and to look up `isActive`. */
  key: string;
  /**
   * Pull the comparable value from a row. Return `null`/`undefined`/`''` for
   * "no value".
   *
   * May also return an ARRAY, for a column where one row legitimately holds
   * several values — an indent split across three vendors, say. Each element
   * becomes its own option, and picking one matches every row containing it.
   * Returning a joined string instead would make "Acme" un-findable on any
   * indent that also used somebody else.
   */
  getValue: (row: T) => string | number | null | undefined | (string | number)[];
};

/**
 * Shared per-column-filter scaffolding. Each page declares a list of {key, getValue} specs
 * for the columns it wants filterable; the hook returns:
 *   - the filter state (a `{ key: selectedValue }` map)
 *   - a single setter `setFilter(key, val)` wired straight to `<ColumnFilter onChange>`
 *   - `filteredRows`: the input rows with every active filter applied (AND across keys)
 *   - `getOptions(key)`: unique values for that column, ready to feed `<ColumnFilter options>`
 *   - `isActive(key)`: convenience for the `filterActive` flag on the column definition
 *
 * Filter matching is exact-string equality on `String(getValue(row))`, or
 * membership when `getValue` returns an array. For dates or derived values,
 * normalise inside `getValue` (e.g. `new Date(r.createdAt).toLocaleDateString()`).
 *
 * Designed for tables of any size — the options list and filteredRows are memoised on
 * `rows` + the relevant inputs. Specs themselves should be a stable reference (declared
 * outside the component, or memoised) so the option list isn't rebuilt every render.
 */
export function useTableFilters<T>(rows: T[], specs: FilterSpec<T>[]) {
  const [filters, setFilters] = useState<Record<string, string>>({});

  const setFilter = useCallback((key: string, val: string) => {
    setFilters((prev) => {
      if ((prev[key] || '') === (val || '')) return prev;
      const next = { ...prev };
      if (val) next[key] = val;
      else delete next[key];
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => setFilters({}), []);

  const filteredRows = useMemo(() => {
    const activeSpecs = specs.filter((s) => !!filters[s.key]);
    if (activeSpecs.length === 0) return rows;
    return rows.filter((row) =>
      activeSpecs.every((spec) => {
        const v = spec.getValue(row);
        if (v == null || v === '') return false;
        // A multi-valued column matches if ANY of its values is the one picked.
        if (Array.isArray(v)) return v.some((x) => String(x) === filters[spec.key]);
        return String(v) === filters[spec.key];
      })
    );
  }, [rows, specs, filters]);

  const getOptions = useCallback(
    (key: string) => {
      const spec = specs.find((s) => s.key === key);
      if (!spec) return [];
      const seen = new Set<string>();
      const out: { value: string; label: string }[] = [];
      for (const row of rows) {
        const v = spec.getValue(row);
        if (v == null || v === '') continue;
        // Each element of a multi-valued column is offered separately, so the
        // dropdown lists vendors rather than combinations of vendors.
        for (const one of Array.isArray(v) ? v : [v]) {
          if (one == null || one === '') continue;
          const s = String(one);
          if (seen.has(s)) continue;
          seen.add(s);
          out.push({ value: s, label: s });
        }
      }
      out.sort((a, b) => a.label.localeCompare(b.label));
      return out;
    },
    [rows, specs]
  );

  const isActive = useCallback((key: string) => !!filters[key], [filters]);

  return { filters, setFilter, clearFilters, filteredRows, getOptions, isActive };
}

/**
 * Column filters over a FULL list, paged in the browser afterwards.
 *
 * Pair with `useServerPagination({ ..., loadAll: true })`: the server returns
 * every matching row, these filters run over all of them (so a value on "page
 * 2" can be found and is offered in the dropdown), and only the filtered
 * result is cut into pages. Render `pageRows`; drive <Pagination> from
 * `page` / `totalPages` / `setPage`. Changing a filter or `resetKey` (pass the
 * search text) goes back to page 1.
 */
export function usePagedFilters<T>(rows: T[], specs: FilterSpec<T>[], pageSize = 10, resetKey = '') {
  const f = useTableFilters(rows, specs);
  const p = useClientPagination(f.filteredRows, pageSize, `${JSON.stringify(f.filters)}|${resetKey}`);
  return { ...f, pageRows: p.pageRows, page: p.page, setPage: p.setPage, totalPages: p.totalPages, filteredTotal: p.total };
}
