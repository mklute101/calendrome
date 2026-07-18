/**
 * Vitest setup: when the engine matrix asks for sql.js
 * (CALENDROME_TEST_ENGINE=sqljs), preload the WASM runtime before any
 * test file runs so `freshDb()` can stay synchronous. Native runs skip
 * this entirely and never load the WASM module.
 */
if (process.env.CALENDROME_TEST_ENGINE === 'sqljs') {
  const { preloadSqlJs } = await import('./helpers/sqljs.js');
  await preloadSqlJs();
}
