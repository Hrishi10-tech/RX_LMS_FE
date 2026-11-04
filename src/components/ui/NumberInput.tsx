import { useEffect, useRef, useState } from 'react';

/**
 * Number input that behaves like a human expects:
 *
 * 1. The "0" can actually be deleted. A raw `<input type="number">` bound to
 *    a `number` state via `setX(Number(e.target.value))` snaps back to 0 the
 *    instant the field goes empty, because `Number("") === 0`. That's the
 *    "I can't clear the zero" bug. We hold a *draft string* internally so
 *    the field can be transiently empty while the user is typing.
 *
 * 2. Leading zeros ("05", "007") normalize to "5", "7" on blur — so once
 *    the user tabs out, the field reads naturally.
 *
 * 3. Focus selects the whole value, matching how every spreadsheet behaves
 *    — typing immediately replaces "1" with "5" instead of producing "15".
 *
 * 4. min/max are enforced on blur (not while typing, which would yank the
 *    cursor mid-stroke).
 *
 * 5. The parent state stays a clean `number` throughout — the ephemeral
 *    string lives inside this component only. Parents pass a numeric value
 *    in, get a numeric value out.
 *
 * If you find yourself reaching for `<input type="number">` directly, use
 * this instead unless you have a very specific reason not to.
 */
export interface NumberInputProps {
    value: number;
    onChange: (n: number) => void;
    min?: number;
    max?: number;
    step?: number | 'any';
    /**
     * Value the field snaps to if the user blurs while empty. Defaults to
     * `min` if provided, otherwise 0. Most callers don't need to set this
     * explicitly.
     */
    fallback?: number;
    /** Forwarded to the underlying input. */
    required?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    placeholder?: string;
    className?: string;
    id?: string;
    name?: string;
    /** Names the box for screen readers when there's no visible <label>. */
    'aria-label'?: string;
    autoFocus?: boolean;
    onFocus?: (e: React.FocusEvent<HTMLInputElement>) => void;
    onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
    /** If true, focus does NOT select-all. Default is false (select). */
    noSelectOnFocus?: boolean;
    /**
     * Whole numbers only (durations, counts). A decimal is rounded on blur —
     * the server rejects "1.5 days" with a validation error, so the box should
     * never be able to hold one.
     */
    integer?: boolean;
}

export const NumberInput = ({
    value,
    onChange,
    min,
    max,
    step,
    fallback,
    required,
    disabled,
    readOnly,
    placeholder,
    className,
    id,
    name,
    'aria-label': ariaLabel,
    autoFocus,
    onFocus,
    onBlur,
    noSelectOnFocus,
    integer,
}: NumberInputProps) => {
    // Draft holds the user's in-progress string. We sync it from `value`
    // only when the field isn't focused — otherwise an external re-render
    // (e.g. sibling onChange) would yank the cursor and overwrite their typing.
    const [draft, setDraft] = useState<string>(() =>
        Number.isFinite(value) ? String(value) : ''
    );
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (document.activeElement === inputRef.current) return;
        const next = Number.isFinite(value) ? String(value) : '';
        if (next !== draft) setDraft(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        let raw = e.target.value;
        // If the field doesn't allow negatives (min >= 0), strip any `-` the
        // user types so the dash never even appears in the box. Avoids the
        // "I typed -5, it shows -5, but on blur it became 0" confusion.
        if (min != null && min >= 0 && raw.includes('-')) {
            raw = raw.replace(/-/g, '');
        }
        setDraft(raw);
        // "" is transient — wait for a real number before pushing up to the
        // parent. Otherwise clearing the field would resolve to Number("") === 0
        // and we'd be right back to the original bug. "-" only matters when
        // negatives are allowed; when min >= 0 it's already stripped above.
        if (raw === '' || raw === '-') return;
        const n = Number(raw);
        if (Number.isFinite(n) && n !== value) onChange(n);
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
        const snapTo = fallback ?? min ?? 0;
        let n = Number(draft);
        if (draft === '' || !Number.isFinite(n)) {
            n = snapTo;
        }
        if (integer) n = Math.round(n);
        if (min != null && n < min) n = min;
        if (max != null && n > max) n = max;
        // Normalised string: strips leading zeros ("05" → "5") and any
        // trailing dot ("3." → "3"). Negative zero collapses to "0".
        const normalised = String(n);
        if (normalised !== draft) setDraft(normalised);
        if (n !== value) onChange(n);
        onBlur?.(e);
    };

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
        if (!noSelectOnFocus) e.target.select();
        onFocus?.(e);
    };

    return (
        <input
            ref={inputRef}
            type="number"
            inputMode={integer ? 'numeric' : 'decimal'}
            value={draft}
            onChange={handleChange}
            onBlur={handleBlur}
            onFocus={handleFocus}
            min={min}
            max={max}
            // 'any' unless told otherwise: the browser's default step of 1
            // marks 2.5 as invalid, and the server takes two decimal places.
            step={integer ? 1 : (step ?? 'any')}
            required={required}
            disabled={disabled}
            readOnly={readOnly}
            placeholder={placeholder}
            className={className}
            id={id}
            name={name}
            aria-label={ariaLabel}
            autoFocus={autoFocus}
        />
    );
};
