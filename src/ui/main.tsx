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

// Set the theme before the first paint; the CSP allows no inline script in index.html.
applyTheme(readTheme());

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
