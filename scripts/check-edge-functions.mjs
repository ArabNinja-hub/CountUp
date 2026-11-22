#!/usr/bin/env node
/**
 * Verifies every Supabase Edge Function (`supabase/functions/<name>/index.ts`)
 * and shared Deno/Edge module (`shared/**`, `supabase/functions/_shared/**`):
 *
 * 1. Static relative-import check: every relative `import` / `export ... from` /
 *    dynamic `import(...)` under `shared/` and `supabase/functions/` MUST end in
 *    an explicit `.ts` extension and resolve to an existing file on disk.
 * 2. `deno check --no-config --node-modules-dir=none`: type-checks and resolves
 *    the full Deno module graph (including `npm:@supabase/supabase-js@2` and
 *    cross-directory `../../../shared/*.ts` imports) for EVERY Edge Function.
 * 3. Optional `--smoke-serve`: invokes EVERY Edge Function through the live
 *    Supabase Edge Runtime (`${SUPABASE_URL}/functions/v1/<name>`) started by
 *    `supabase start` / `supabase functions serve`, proving each function compiles
 *    into an ESZIP bundle, boots cleanly, and returns its expected JSON response.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function emitCiError(title, message) {
  const escaped = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`::error title=${title}::${escaped}`);
}

export function collectCodeFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectCodeFiles(fullPath));
    } else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

/**
 * Extracts all module specifiers from static `import`/`export ... from` and
 * dynamic `import(...)` expressions after stripping comments.
 */
export function findRelativeImportViolationsInSource(sourceText, filePath, rootDir = repoRoot) {
  const stripped = sourceText
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  const violations = [];
  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(stripped)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        continue;
      }
      const line = stripped.slice(0, match.index).split('\n').length;
      const relFile = path.relative(rootDir, filePath);

      if (!specifier.endsWith('.ts')) {
        violations.push(
          `${relFile}:${line} — relative import "${specifier}" is missing an explicit ".ts" extension (required by Deno / Supabase Edge Functions).`
        );
        continue;
      }

      const resolved = path.resolve(path.dirname(filePath), specifier);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        violations.push(
          `${relFile}:${line} — relative import "${specifier}" does not resolve to a file (${path.relative(rootDir, resolved)}).`
        );
      }
    }
  }

  return violations;
}

export function discoverEdgeFunctions(
  functionsRoot = path.join(repoRoot, 'supabase', 'functions')
) {
  const names = fs
    .readdirSync(functionsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();

  const functions = [];
  for (const name of names) {
    const entrypoint = path.join(functionsRoot, name, 'index.ts');
    if (!fs.existsSync(entrypoint)) {
      throw new Error(`Edge Function directory "supabase/functions/${name}" is missing index.ts`);
    }
    functions.push({ name, entrypoint });
  }
  return functions;
}

function resolveDenoCommand() {
  const direct = spawnSync('deno', ['--version'], { stdio: 'pipe', encoding: 'utf8' });
  if (direct.status === 0) {
    return { cmd: 'deno', prefixArgs: [] };
  }
  return { cmd: 'npx', prefixArgs: ['--yes', 'deno@2.2.4'] };
}

async function smokeTestServedFunctions(functions) {
  const baseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const anonKey = (process.env.SUPABASE_ANON_KEY ?? '').trim();
  if (!baseUrl || !anonKey) {
    throw new Error(
      '--smoke-serve requires SUPABASE_URL and SUPABASE_ANON_KEY in the environment.'
    );
  }

  console.log(
    `[edge-smoke] Bundling & invoking all ${functions.length} Edge Functions via ${baseUrl}/functions/v1/* ...`
  );

  for (const fn of functions) {
    const url = `${baseUrl}/functions/v1/${fn.name}`;
    const isSmsWebhook = fn.name === 'send-sms-hook';

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${anonKey}`,
        apikey: anonKey,
        ...(isSmsWebhook ? {} : { Origin: 'https://disallowed-ci-smoke-origin.example' }),
      },
      body: '{}',
    });

    const rawText = await res.text();
    let body = null;
    try {
      body = JSON.parse(rawText);
    } catch {
      throw new Error(
        `Function "${fn.name}" returned non-JSON response (HTTP ${res.status}): ${rawText.slice(0, 300)}`
      );
    }

    if (isSmsWebhook) {
      assert.equal(
        res.status,
        401,
        `Expected send-sms-hook to boot and return 401 Invalid webhook signature, got HTTP ${res.status}: ${rawText}`
      );
      assert.equal(body?.error, 'Invalid webhook signature');
    } else {
      assert.equal(
        res.status,
        403,
        `Expected "${fn.name}" to boot and reject disallowed Origin with 403 forbidden_origin, got HTTP ${res.status}: ${rawText}`
      );
      assert.equal(body?.code, 'forbidden_origin');
    }

    console.log(`  ✓ ${fn.name} bundled & booted cleanly (HTTP ${res.status})`);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const skipDeno = args.has('--static-only');
  const smokeServe = args.has('--smoke-serve');

  const scannedFiles = [
    ...collectCodeFiles(path.join(repoRoot, 'shared')),
    ...collectCodeFiles(path.join(repoRoot, 'supabase', 'functions')),
  ];

  const violations = [];
  for (const file of scannedFiles) {
    const content = fs.readFileSync(file, 'utf8');
    violations.push(...findRelativeImportViolationsInSource(content, file, repoRoot));
  }

  if (violations.length > 0) {
    const report = violations.join('\n');
    emitCiError('Edge Function Import Check Failed', report);
    throw new Error(`Found ${violations.length} Deno relative-import violation(s):\n${report}`);
  }

  const functions = discoverEdgeFunctions();
  assert.ok(
    functions.length >= 17,
    `Expected at least 17 Edge Functions under supabase/functions/, found ${functions.length}`
  );
  console.log(
    `[edge-check] Verified explicit .ts extensions across ${scannedFiles.length} shared/Edge files (${functions.length} Edge Functions).`
  );

  if (!skipDeno) {
    const { cmd, prefixArgs } = resolveDenoCommand();
    const entrypoints = functions.map((f) => path.relative(repoRoot, f.entrypoint));
    console.log(`[edge-check] Running deno check on all ${entrypoints.length} Edge Functions...`);
    execFileSync(
      cmd,
      [
        ...prefixArgs,
        'check',
        '--no-config',
        '--no-lock',
        '--node-modules-dir=none',
        ...entrypoints,
      ],
      {
        cwd: repoRoot,
        stdio: 'inherit',
      }
    );
    console.log(`[edge-check] deno check passed for all ${entrypoints.length} Edge Functions.`);
  }

  if (smokeServe) {
    await smokeTestServedFunctions(functions);
    console.log(`[edge-smoke] All ${functions.length} Edge Functions bundled and served cleanly.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    emitCiError(
      'Edge Function Verification Failed',
      err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    );
    process.exit(1);
  });
}
