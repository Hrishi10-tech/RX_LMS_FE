/**
 * Shared indent-status helpers. "Customs clearance" is not a real IndentStatus
 * enum value — it's a user-facing pseudo-status we surface for an in-transit
 * indent that has any customs activity recorded. Keeping the derivation here
 * means the Indents page, the Requests page and the BOM status rollup all show
 * the exact same stage for the same indent.
 */

export const hasCustomsActivity = (indent: any): boolean =>
  (Array.isArray(indent?.customsDutyPayments) && indent.customsDutyPayments.length > 0) ||
  !!indent?.customsDocumentationNotes || !!indent?.customsDeliveryOrderChaNotes ||
  !!indent?.customsDutyAwb || !!indent?.customsDutyShippingAgent || !!indent?.customsDutyShippingBill ||
  // A line marked at the CUSTOMS stage on the shipment tracker is, by itself,
  // customs activity — so an international shipment held at customs surfaces as
  // CUSTOMS_CLEARANCE even before any duty row / paperwork is recorded.
  (Array.isArray(indent?.vendorAllocations) && indent.vendorAllocations.some((a: any) => a?.shipmentStage === 'CUSTOMS'));

export const inCustomsClearance = (indent: any): boolean =>
  indent?.status === 'IN_TRANSIT' && hasCustomsActivity(indent);

/** The status to badge — real IndentStatus, except in-transit-with-customs surfaces as CUSTOMS_CLEARANCE. */
export const effectiveIndentStatus = (indent: any): string =>
  inCustomsClearance(indent) ? 'CUSTOMS_CLEARANCE' : (indent?.status || 'UNKNOWN');
