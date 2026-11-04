import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { seedFxFromCache, bootstrapFxRates } from './lib/fx'
import { seedApprovalPolicyFromCache, bootstrapApprovalPolicy } from './lib/approvalPolicy'
import { installGlobalErrorReporting } from './lib/logError'
import { installNumberInputGuard } from './lib/numberInputGuard'

// Catch the failures that never reach a `.catch(logError)` — a component
// throwing during render, a promise rejected with nobody listening. Those were
// the quiet ones: they left a blank panel or a dead button and no trace
// anywhere a person would look. Installed before the first render so a crash
// during boot is reported too.
installGlobalErrorReporting()

// Scroll-wheel and "e" in number boxes — see numberInputGuard.
installNumberInputGuard()

// Seed FX rates from the last cached snapshot BEFORE first render so currency
// conversions use last-known-live rates immediately (no static flash), then
// revalidate from the backend in the background.
seedFxFromCache()
void bootstrapFxRates()

// Same idea for the approval policy (is CEO sign-off required?). Seed from cache
// so approval columns are right on first paint. On the very first ever load
// there's nothing cached — wait for that one small public request rather than
// flashing the wrong approval state, but never let it block the app: if it
// fails or hangs we render on the default (CEO optional) and the backend, which
// is the only real enforcer, stays authoritative either way.
const renderApp = () =>
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )

if (seedApprovalPolicyFromCache()) {
  void bootstrapApprovalPolicy()
  renderApp()
} else {
  void bootstrapApprovalPolicy().finally(renderApp)
}
