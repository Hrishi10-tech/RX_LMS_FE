import { Providers } from './app/Providers';
import { AppRoutes } from './AppRoutes';
import { OfflineBanner } from './components/ui/OfflineBanner';
import { NewVersionBanner } from './components/ui/NewVersionBanner';

function App() {
  return (
    <Providers>
      <OfflineBanner />
      <NewVersionBanner />
      <AppRoutes />
    </Providers>
  );
}

export default App;
