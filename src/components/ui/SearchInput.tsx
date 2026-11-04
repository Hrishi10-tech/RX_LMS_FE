import { ChangeEvent, KeyboardEvent } from 'react';

interface SearchInputProps {
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  /** For a search box that appears on demand — opening one you then have to
   *  click into defeats the point of opening it. */
  autoFocus?: boolean;
  /** So a caller can close an on-demand search on Escape. */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

export const SearchInput = ({ value, onChange, placeholder = 'Search...', autoFocus, onKeyDown }: SearchInputProps) => {
  return (
    <div className="relative w-full">
      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
        <svg className="h-5 w-5 text-muted" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
        </svg>
      </div>
      <input
        type="text"
        className="input-glass block w-full pl-10 sm:text-sm rounded-xl py-2 px-3 text-ink"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
      />
    </div>
  );
};
