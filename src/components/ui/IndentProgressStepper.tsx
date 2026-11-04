const STEPS = [
  { key: 'PENDING', label: 'Submitted' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'QUOTATION_IN_PROGRESS', label: 'Quoting' },
  // Finance's only job here is to pay, so "sent to finance" (AWAITING_PAYMENT)
  // and "paid" (PAYMENT_DONE) are ONE stage: current while awaiting payment,
  // ✓ once paid (PAYMENT_DONE handled via DONE_THROUGH below).
  { key: 'AWAITING_PAYMENT', label: 'Payment' },
  { key: 'ORDERED', label: 'Ordered' },
  { key: 'IN_TRANSIT', label: 'Shipped' },
  { key: 'RECEIVED', label: 'Received' },
];

const TERMINAL = ['REJECTED', 'CANCELLED'];

export const IndentProgressStepper = ({ status, quoted = false }: { status: string; quoted?: boolean }) => {
  if (TERMINAL.includes(status)) {
    return (
      <div className="flex items-center gap-2 py-2">
        <div className={`w-3 h-3 rounded-full ${status === 'REJECTED' ? 'bg-red-500' : 'bg-faint'}`} />
        <span className={`text-xs font-bold ${status === 'REJECTED' ? 'text-red-700 dark:text-red-300' : 'text-muted'}`}>{status.replace(/_/g, ' ')}</span>
      </div>
    );
  }

  // PARTIALLY_RECEIVED isn't its own bubble — it's the shipping leg still in
  // progress (some vendors delivered, others in transit). Anchor it to the
  // "Shipped" step as the current stage; the precise per-vendor state shows in
  // the status badge + track modal. Keeps the pipeline at 8 steps for everyone
  // and avoids a false ✓ on a "Partial" step for indents that never split.
  // STEP_ALIAS maps a status without its own bubble onto the step it's currently
  // AT. PARTIALLY_RECEIVED → the shipping leg (some vendors still in transit).
  const STEP_ALIAS: Record<string, string> = { PARTIALLY_RECEIVED: 'IN_TRANSIT' };
  // DONE_THROUGH marks handoff-in-progress states: everything up to & INCLUDING
  // the named step is done, but NO bubble is "current" — the file sits with a
  // team preparing the next stage, not at a numbered stage yet.
  //   - READY_FOR_PAYMENT: all approvals cleared + quote done, but it's still
  //     with procurement (picking the payment method) — so Submitted/Approved/
  //     Quoting show done and Finance stays grey until it's actually sent to
  //     Finance (AWAITING_PAYMENT → Finance current; PAYMENT_DONE → Finance ✓).
  //   - PAYMENT_DONE: finance has paid, so Payment shows ✓; the file is now back
  //     with procurement to place the order, so no bubble is current until ORDERED.
  const DONE_THROUGH: Record<string, string> = {
    READY_FOR_PAYMENT: 'QUOTATION_IN_PROGRESS',
    PAYMENT_DONE: 'AWAITING_PAYMENT',
  };
  // A quote that comes in above the approved figure sends the indent back to
  // PENDING and clears the signatures (indents.service — "the previous
  // sign-off was for a different indent"). Read literally, that drew the bar
  // at step 1, "Submitted", for an indent that had already been approved once
  // and quoted — directly above a timeline listing both. The bar contradicted
  // its own history.
  //
  // `quoted` says a quotation exists, so the pipeline is no longer a straight
  // line: the file is waiting at Approved for a second signature, with Quoting
  // already behind it. Showing that is truthful; showing "Submitted" is not.
  //
  // Only PENDING is remapped. Every later status already sits past Approved,
  // so a quote changes nothing about where they are.
  const awaitingReApproval = status === 'PENDING' && quoted;
  const effectiveStatus = awaitingReApproval ? 'APPROVED' : status;
  const doneThroughIdx = DONE_THROUGH[status] ? STEPS.findIndex(s => s.key === DONE_THROUGH[status]) : -1;
  const currentIdx = doneThroughIdx >= 0 ? -1 : STEPS.findIndex(s => s.key === (STEP_ALIAS[effectiveStatus] || effectiveStatus));
  // Everything up to and including Quoting has demonstrably happened once a
  // quotation exists. Normally implied by `idx < currentIdx`; it only adds
  // anything when the file has gone BACKWARDS past a step it already cleared.
  const quotedIdx = quoted ? STEPS.findIndex(s => s.key === 'QUOTATION_IN_PROGRESS') : -1;
  // RECEIVED is the happy terminal state — the pipeline is done, not "in
  // progress at the last step". Without this branch the last bubble rendered
  // the step number ("8") with a ring around it, making a fully-received
  // indent look like it was still stuck on the final step.
  const reachedEnd = status === 'RECEIVED';

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto py-1">
      {STEPS.map((step, idx) => {
        const isDone = doneThroughIdx >= 0
          ? idx <= doneThroughIdx                       // handoff state: done up to & incl. the named step, no current bubble
          : idx < currentIdx
            || (reachedEnd && idx === currentIdx)
            || (idx <= quotedIdx && idx !== currentIdx); // already cleared, even if the file came back
        const isCurrent = doneThroughIdx >= 0 ? false : (idx === currentIdx && !reachedEnd);

        return (
          <div key={step.key} className="flex items-center">
            {idx > 0 && (
              <div className={`w-3 sm:w-5 h-0.5 ${isDone ? 'bg-brand' : 'bg-line'}`} />
            )}
            <div className="flex flex-col items-center" title={step.label}>
              <div className={`w-4 h-4 sm:w-5 sm:h-5 rounded-full flex items-center justify-center text-[8px] sm:text-[9px] font-bold ${
                isDone ? 'bg-brand text-white' :
                isCurrent ? 'bg-brand text-white ring-2 ring-brand/30 ring-offset-1' :
                'bg-line text-faint'
              }`}>
                {isDone ? '✓' : idx + 1}
              </div>
              <span className={`text-[7px] sm:text-[8px] mt-0.5 whitespace-nowrap ${
                isCurrent ? 'text-brand font-bold' : isDone ? 'text-muted' : 'text-faint'
              }`}>{step.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
