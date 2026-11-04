// Vitest global setup: extends `expect` with the jest-dom matchers
// (toBeInTheDocument, etc.) so component tests can use them. Pure-function
// specs don't need these, but the harness is wired for component tests too.
import '@testing-library/jest-dom';
