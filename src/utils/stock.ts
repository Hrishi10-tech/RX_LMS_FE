/**
 * Text-colour class for an on-hand stock figure: red when out (0), amber when
 * below the low-stock threshold, green when healthy. Consolidates the three
 * hand-rolled copies (inventory table, super-admin inventory, standard
 * dashboard) — pass the threshold each surface used (10, or its configured
 * low-stock level).
 */
export const stockColorClass = (stock: number, threshold: number): string =>
  stock === 0 ? 'text-red-700 dark:text-red-300' : stock < threshold ? 'text-amber-700 dark:text-amber-300' : 'text-green-700 dark:text-green-300';
