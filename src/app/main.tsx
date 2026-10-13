import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ApiError } from './api';
import { ThemeProvider } from './ThemeProvider';
import { applyTheme, readTheme } from './theme';
import './style.css';
import './polish.css';
import './responsive.css';
import './sidebar.css';
import './agents.css';
import './theme.css';
import './settings.css';

// A request the server refused (4xx other than 429) fails at once instead of retrying and reading as offline.
const client = new QueryClient({ defaultOptions: { queries: { retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status < 500 && error.status !== 429), refetchOnWindowFocus: false } } });
applyTheme(readTheme(), window.matchMedia('(prefers-color-scheme: dark)').matches);
createRoot(document.getElementById('root')!).render(<React.StrictMode><ThemeProvider><QueryClientProvider client={client}><App /></QueryClientProvider></ThemeProvider></React.StrictMode>);

import './workspace.css';

import './projects.css';
