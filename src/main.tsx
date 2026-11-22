import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ExclusiveSession } from './components/ExclusiveSession.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <ExclusiveSession>
    <App />
  </ExclusiveSession>
);

// Register only built releases, never the Vite development server.
// `updateViaCache: 'none'` ensures the browser always checks the network for a
// newer `sw.js` without serving stale HTTP cache copies, while the worker
// stages new static assets in a versioned cache and activates cleanly once
// existing tabs close so an in-progress sale is never interrupted.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
  let lastUpdateCheckAt = Date.now();

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
      .then((registration) => {
        const checkForWorkerUpdate = () => {
          if (!navigator.onLine) return;
          lastUpdateCheckAt = Date.now();
          void registration.update().catch(() => {});
        };

        window.addEventListener('online', checkForWorkerUpdate);
        document.addEventListener('visibilitychange', () => {
          if (
            document.visibilityState === 'visible' &&
            Date.now() - lastUpdateCheckAt >= UPDATE_CHECK_INTERVAL_MS
          ) {
            checkForWorkerUpdate();
          }
        });
      })
      .catch((error: unknown) => console.warn('Offline app setup failed:', error));
  });
}
