#!/usr/bin/env node
// Extract inline-comment-driven documentation for the GUI /docs page.
// Source of truth: TSDoc/JSDoc block comments in source files + the SQL
// schema. Run as a build step; output: dist/src/gui/public/docs.json.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = join(ROOT, 'dist', 'src', 'gui', 'public', 'docs.json');

// Modules to introspect for top-of-file TSDoc summaries.
const MODULE_PATHS = [
  'src/mcp/server.ts',
  'src/mcp/tools/index.ts',
  'src/db/connection.ts',
  'src/gui/server.ts',
  'src/calendar-sync.ts',
  'src/categories.ts',
  'src/availability.ts',
];

const TOOLS_FILE = 'src/mcp/tools/index.ts';
const GUI_FILE = 'src/gui/server.ts';
const SCHEMA_FILE = 'src/db/schema.sql';

// ---------- shared helpers ----------

function readSource(rel) {
  const path = join(ROOT, rel);
  return { path, text: readFileSync(path, 'utf8') };
}

function makeSourceFile(rel) {
  const { text } = readSource(rel);
  return ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);
}

// Pull leading /** ... */ blocks. Returns the parsed JSDoc body, or null.
function getLeadingJsDoc(source, node) {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart());
  if (!ranges) return null;
  // Take the last block-comment that is JSDoc-style (starts with /**)
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    if (r.kind !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const raw = source.text.slice(r.pos, r.end);
    if (!raw.startsWith('/**')) continue;
    return parseJsDoc(raw);
  }
  return null;
}

// Parse a /** ... */ block into { summary, examples, seeAlso }.
function parseJsDoc(raw) {
  // Strip /** and */ and per-line " * " prefix
  const inner = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();

  // Split on @tag boundaries.
  const lines = inner.split('\n');
  const summaryLines = [];
  const examples = [];
  const seeAlso = [];
  let mode = 'summary';
  let exampleBuf = null;

  for (const line of lines) {
    const tagMatch = line.match(/^@(\w+)\b\s*(.*)$/);
    if (tagMatch) {
      // flush in-progress example
      if (exampleBuf !== null) {
        examples.push(exampleBuf.trim());
        exampleBuf = null;
      }
      const tag = tagMatch[1];
      const rest = tagMatch[2];
      if (tag === 'example') {
        mode = 'example';
        exampleBuf = rest;
      } else if (tag === 'see') {
        mode = 'see';
        for (const ref of rest.split(/[,\s]+/).filter(Boolean)) {
          seeAlso.push(ref);
        }
      } else {
        mode = 'other';
      }
      continue;
    }
    if (mode === 'summary') summaryLines.push(line);
    else if (mode === 'example' && exampleBuf !== null) {
      exampleBuf += '\n' + line;
    } else if (mode === 'see') {
      for (const ref of line.split(/[,\s]+/).filter(Boolean)) seeAlso.push(ref);
    }
  }
  if (exampleBuf !== null) examples.push(exampleBuf.trim());

  return {
    summary: summaryLines.join('\n').trim(),
    examples,
    seeAlso,
  };
}

// ---------- modules ----------

function extractModuleSummary(rel) {
  const source = makeSourceFile(rel);
  // The first statement is usually an import; the leading comment on it is
  // (by ts.getLeadingCommentRanges) actually attached to the SourceFile's
  // first child. Look at the first child node.
  const first = source.statements[0] ?? source.endOfFileToken;
  const doc = getLeadingJsDoc(source, first);
  return {
    path: rel,
    summary: doc?.summary ?? '',
  };
}

// ---------- MCP tools ----------

function extractTools() {
  const source = makeSourceFile(TOOLS_FILE);
  const out = [];

  // Walk: find function `buildTools`, locate its return statement,
  // iterate object literals in the returned array.
  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'buildTools' &&
      node.body
    ) {
      for (const stmt of node.body.statements) {
        if (
          ts.isReturnStatement(stmt) &&
          stmt.expression &&
          ts.isArrayLiteralExpression(stmt.expression)
        ) {
          for (const el of stmt.expression.elements) {
            if (ts.isObjectLiteralExpression(el)) {
              const name = readStringProp(el, 'name');
              if (!name) continue;
              const doc = getLeadingJsDoc(source, el);
              out.push({
                name,
                summary: doc?.summary ?? '',
                examples: doc?.examples ?? [],
                seeAlso: doc?.seeAlso ?? [],
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return out;
}

function readStringProp(obj, key) {
  for (const p of obj.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === key &&
      ts.isStringLiteral(p.initializer)
    ) {
      return p.initializer.text;
    }
  }
  return null;
}

// ---------- GUI endpoints ----------

function extractEndpoints() {
  const source = makeSourceFile(GUI_FILE);
  const out = [];
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);

  function visit(node) {
    // Match `app.<method>('/api/...', handler)` — or any <method> on app-like.
    if (ts.isExpressionStatement(node)) {
      const expr = node.expression;
      if (
        ts.isCallExpression(expr) &&
        ts.isPropertyAccessExpression(expr.expression) &&
        ts.isIdentifier(expr.expression.expression) &&
        expr.expression.expression.text === 'app' &&
        ts.isIdentifier(expr.expression.name) &&
        methods.has(expr.expression.name.text) &&
        expr.arguments.length >= 1 &&
        ts.isStringLiteral(expr.arguments[0])
      ) {
        const path = expr.arguments[0].text;
        if (path.startsWith('/api/')) {
          const doc = getLeadingJsDoc(source, node);
          out.push({
            method: expr.expression.name.text.toUpperCase(),
            path,
            summary: doc?.summary ?? '',
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return out;
}

// ---------- DB schema ----------

function extractTables() {
  const sql = readFileSync(join(ROOT, SCHEMA_FILE), 'utf8');
  const out = [];
  const re = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\);/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    const body = m[2];
    const columns = [];
    const references = [];
    // Split on commas that aren't inside parens.
    const lines = splitTopLevelCommas(body);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // A column line starts with an identifier; constraint-only lines
      // (UNIQUE, PRIMARY KEY, FOREIGN KEY, CHECK) are skipped.
      const upper = trimmed.toUpperCase();
      if (
        upper.startsWith('UNIQUE') ||
        upper.startsWith('PRIMARY KEY') ||
        upper.startsWith('FOREIGN KEY') ||
        upper.startsWith('CHECK')
      ) {
        continue;
      }
      const colMatch = trimmed.match(/^(\w+)\s+([A-Z]+(?:\s*\([^)]*\))?)/i);
      if (!colMatch) continue;
      const colName = colMatch[1];
      const colType = colMatch[2].toUpperCase().replace(/\s+/g, '');
      const notNull = /\bNOT NULL\b/i.test(trimmed);
      const isPk = /\bPRIMARY KEY\b/i.test(trimmed);
      const refMatch = trimmed.match(/REFERENCES\s+(\w+)\s*\((\w+)\)/i);
      columns.push({
        name: colName,
        type: colType,
        notNull,
        primaryKey: isPk,
        references: refMatch ? `${refMatch[1]}.${refMatch[2]}` : null,
      });
      if (refMatch) {
        references.push({
          column: colName,
          table: refMatch[1],
          target: refMatch[2],
        });
      }
    }
    out.push({ name, columns, references });
  }
  return out;
}

function splitTopLevelCommas(s) {
  const parts = [];
  let depth = 0;
  let buf = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

// ---------- main ----------

function main() {
  const modules = MODULE_PATHS.map(extractModuleSummary);
  const tools = extractTools();
  const endpoints = extractEndpoints();
  const tables = extractTables();

  const docs = {
    generated_at: new Date().toISOString(),
    modules,
    tools,
    endpoints,
    tables,
  };

  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(docs, null, 2));
  const rel = relative(ROOT, OUT);
  console.log(
    `[extract-docs] wrote ${rel} — ${modules.length} modules, ${tools.length} tools, ${endpoints.length} endpoints, ${tables.length} tables`,
  );
}

main();
