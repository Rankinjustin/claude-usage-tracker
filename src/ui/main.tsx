import '@fontsource/geist-sans/latin-400.css';
import '@fontsource/geist-sans/latin-500.css';
import '@fontsource/geist-sans/latin-600.css';
import '@fontsource/geist-mono/latin-400.css';
import '@fontsource/geist-mono/latin-500.css';
import './theme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, readTheme } from './components/Sidebar';

// The launcher opens /?key=…; the server has set the HttpOnly cookie by now, so drop the key from the
// address bar and history (it would otherwise show in screenshots).
if (new URLSearchParams(window.location.search).has('key')) {
  window.history.replaceState(null, '', window.location.pathname + window.location.hash);
}

// Set the theme before the first paint; the CSP allows no inline script in index.html.
applyTheme(readTheme());

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
