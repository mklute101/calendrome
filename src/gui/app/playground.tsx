/**
 * Playground entry — the calendrome GUI running fully in the browser
 * (WordPress-Playground style). Boots a sql.js (WASM) database, applies
 * the real schema, seeds the canonical fictional demo dataset, swaps
 * the API layer's backend for the in-browser one, and renders the
 * exact same <App/> the real GUI serves.
 *
 * Everything is bundled locally (WASM via Vite `?url`, schema via
 * `?raw`) — no CDN, no server, no personal data. The database lives in
 * this tab's memory and resets on reload; that's the point.
 */
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js';
import sqlJsWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import schemaSql from '../../db/schema.sql?raw';
import { wrapSqlJsDatabase } from '../../db/sqljs-adapter';
import { seedDemo } from '../../demo-seed';
import { setBackend } from './api';
import { createLocalBackend } from './local-backend';
import App from './App';
import './styles.css';

function PlaygroundBanner() {
  return (
    <div className="playground-banner" role="note">
      <span className="playground-banner-chip">Demo playground</span>
      <span>
        Sample data, lives in this tab, resets on reload — drag, complete,
        snooze away.
      </span>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);

async function boot() {
  const SQL = await initSqlJs({ locateFile: () => sqlJsWasmUrl });
  const db = wrapSqlJsDatabase(new SQL.Database());
  db.exec(schemaSql);
  seedDemo(db);
  setBackend(createLocalBackend(db));

  // The playground has no personal data to hide — default to the full
  // view so all three demo projects show. (First visit only; the pref
  // is sticky after that, same as the real GUI.)
  if (!localStorage.getItem('calendrome-category-view')) {
    localStorage.setItem('calendrome-category-view', 'all');
  }

  root.render(
    <>
      <PlaygroundBanner />
      <App />
    </>,
  );
}

void boot().catch((err) => {
  root.render(
    <div className="playground-banner playground-banner-error" role="alert">
      Playground failed to start: {err instanceof Error ? err.message : String(err)}
    </div>,
  );
});
