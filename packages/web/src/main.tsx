import '@fontsource-variable/archivo/wdth.css';
import './styles/tokens.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import type { DataSource } from './data/types';

// The data source is fixed at build time: `vite build --mode demo` bundles the fictional squad and
// no network code path; the default build talks to the local agent that serves it.
async function pickSource(): Promise<DataSource> {
  if (import.meta.env.MODE === 'demo') {
    const { createDemoSource } = await import('./data/demo');
    return createDemoSource();
  }
  const { createAgentSource } = await import('./data/agent');
  return createAgentSource();
}

const root = document.getElementById('root');
if (root) {
  void pickSource().then((source) => {
    createRoot(root).render(
      <StrictMode>
        <App source={source} />
      </StrictMode>,
    );
  });
}
