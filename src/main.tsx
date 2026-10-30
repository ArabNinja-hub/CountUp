import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ExclusiveSession } from './components/ExclusiveSession.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <ExclusiveSession>
    <App />
  </ExclusiveSession>
);

// Register only built releases, never the Vite development server. The worker
// caches application files so an existing shop can reopen without a connection.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((error: unknown) => console.warn('Offline app setup failed:', error));
  });
}
