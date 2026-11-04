import { useState, useRef, useEffect } from 'react';

interface EditableCellProps {
  value: string | number;
  type?: 'text' | 'number' | 'date' | 'select';
  options?: { value: string; label: string }[];
  onSave: (val: string | number) => void;
  className?: string;
  /** If true, render as plain text (no pencil icon, no edit affordance). Used
   *  when the parent context disallows edits — e.g. an indent in Quotation. */
  readOnly?: boolean;
  /** Muted text shown when the value is empty, e.g. "—" or "Add a name".
   *  Without one an empty cell renders as blank space with a pencil that only
   *  appears on hover, which gives the user nothing to aim at and reads as a
   *  rendering fault rather than an empty field. */
  placeholder?: string;
}

export const EditableCell = ({ value, type = 'text', options = [], onSave, className = '', readOnly = false, placeholder }: EditableCellProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [currentValue, setCurrentValue] = useState(value);
  const inputRef = useRef<any>(null);

  useEffect(() => {
    setCurrentValue(value);
  }, [value]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const handleBlur = () => {
    setIsEditing(false);
    // Reject NaN / Infinity / negative numbers before they reach state — typing
    // "abc" in a number input used to produce NaN, which then rendered as "NaN"
    // and broke any downstream qty * price math.
    if (type === 'number') {
      const num = typeof currentValue === 'number' ? currentValue : Number(currentValue);
      if (!Number.isFinite(num) || num < 0) {
        setCurrentValue(value);
        return;
      }
    }
    if (currentValue !== value) {
      onSave(currentValue);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      // Save once this keypress is over, not during it. Saving can open a
      // dialog (a stock change asks why), and while the key was still being
      // handled that same Enter reached the dialog and closed it — the change
      // was dropped with nothing on screen to say so.
      e.preventDefault();
      setTimeout(() => inputRef.current?.blur(), 0);
    } else if (e.key === 'Escape') {
      setCurrentValue(value);
      setIsEditing(false);
    }
  };

  if (isEditing) {
    if (type === 'select') {
      return (
        <select
          ref={inputRef}
          value={currentValue}
          onChange={(e) => setCurrentValue(e.target.value)}
          onBlur={handleBlur}
          className={`block w-full min-w-[60px] max-w-full border border-line focus:ring-brand focus:border-brand rounded-md shadow-sm text-sm py-1 ${className}`}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    }

    return (
      <input
        ref={inputRef}
        type={type}
        min={type === 'number' ? 0 : undefined}
        step={type === 'number' ? 'any' : undefined}
        value={currentValue as string | number}
        onChange={(e) => {
          if (type === 'number') {
            const raw = e.target.value;
            // Keep empty string in transit so the user can clear → retype.
            if (raw === '' || raw === '-') {
              setCurrentValue(raw);
              return;
            }
            const num = Number(raw);
            if (Number.isFinite(num)) setCurrentValue(num);
          } else {
            setCurrentValue(e.target.value);
          }
        }}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className={`block w-full min-w-[60px] max-w-full border border-line focus:border-brand focus:ring-brand rounded-md shadow-sm text-sm py-1 px-2 ${className}`}
      />
    );
  }

  let displayValue: string | number = value;
  let isInvalidDate = false;
  if (type === 'select' && options.length > 0) {
    displayValue = options.find((opt) => opt.value === value)?.label || value;
  } else if (type === 'date' && typeof value === 'string') {
    // Distinguish "no date" (empty/null, display '-') from "corrupt date"
    // (non-empty but doesn't parse — display 'Invalid' in red). Previously
    // both rendered as '-', so users couldn't tell whether a save failed,
    // the data was clean, or upstream sent garbage.
    if (!value) {
      displayValue = '-';
    } else {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        displayValue = 'Invalid';
        isInvalidDate = true;
      } else {
        const iso = parsed.toISOString().split('T')[0];
        const [y, m, d] = iso.split('-');
        displayValue = `${d}-${m}-${y}`;
      }
    }
  }

  if (readOnly) {
    return (
      <span className={`truncate ${isInvalidDate ? 'text-red-700 dark:text-red-300 italic' : ''} ${className}`}
        title={isInvalidDate ? `Stored value "${value}" is not a valid date` : undefined}>
        {displayValue}
      </span>
    );
  }

  const isEmpty = displayValue === '' || displayValue === undefined || displayValue === null;

  return (
    <div className={`group relative flex items-center min-h-[24px] w-full ${className}`}>
      <span
        className={`truncate flex-1 ${isInvalidDate ? 'text-red-700 dark:text-red-300 italic' : ''} ${isEmpty && placeholder ? 'text-faint' : ''}`}
        title={isInvalidDate ? `Stored value "${value}" is not a valid date` : undefined}
      >{isEmpty && placeholder ? placeholder : displayValue}</span>
      <button
        type="button"
        onClick={() => setIsEditing(true)}
        // Icon-only, so it needs a name: screen readers announced "button".
        aria-label="Edit value"
        className="opacity-0 group-hover:opacity-100 ml-2 text-brand hover:text-brand-dark transition-opacity flex-shrink-0 cursor-pointer p-0.5 rounded hover:bg-brand/10"
      >
         <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
      </button>
    </div>
  );
};
