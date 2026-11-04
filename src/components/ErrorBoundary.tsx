import { Component, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  /** How many times the user has asked to recover from THIS mount. */
  attempts: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, attempts: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, info.componentStack);
  }

  /**
   * First click clears the error and re-renders — enough for a transient
   * failure. If it breaks again, reload instead: re-rendering cannot fix the
   * common causes (a stale code-split chunk after a deploy, a corrupt cached
   * response), and a button that visibly does nothing twice is worse than one
   * that takes the heavier action.
   */
  handleReset = () => {
    if (this.state.attempts >= 1) {
      window.location.reload();
      return;
    }
    this.setState((prev) => ({ hasError: false, error: null, attempts: prev.attempts + 1 }));
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center min-h-[300px] p-8 text-center">
          <div className="rounded-xl bg-card shadow-sm border border-line p-8 max-w-md w-full">
            <div className="text-4xl mb-4">!</div>
            <h2 className="text-xl font-semibold text-ink mb-2">
              Something went wrong
            </h2>
            <p className="text-sm text-muted mb-6">
              An unexpected error occurred. Please try again.
            </p>
            <button
              onClick={this.handleReset}
              className="px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              {this.state.attempts >= 1 ? 'Reload the page' : 'Try again'}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
