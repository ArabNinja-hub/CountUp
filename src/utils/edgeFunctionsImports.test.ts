import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectCodeFiles,
  discoverEdgeFunctions,
  findRelativeImportViolationsInSource,
} from '../../scripts/check-edge-functions.mjs';

describe('Supabase Edge Functions & shared/ Deno import integrity', () => {
  it('requires explicit .ts extensions and existing targets on every relative import in shared/ and supabase/functions/', () => {
    const repoRoot = process.cwd();
    const files = [
      ...collectCodeFiles(path.join(repoRoot, 'shared')),
      ...collectCodeFiles(path.join(repoRoot, 'supabase', 'functions')),
    ];

    const violations: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      violations.push(...findRelativeImportViolationsInSource(content, file, repoRoot));
    }

    expect(violations).toEqual([]);

    const functions = discoverEdgeFunctions(path.join(repoRoot, 'supabase', 'functions'));
    expect(functions.length).toBeGreaterThanOrEqual(17);
    for (const fn of functions) {
      const code = fs.readFileSync(fn.entrypoint, 'utf8');
      expect(code, `${fn.name}/index.ts should register Deno.serve`).toContain('Deno.serve(');
    }
  });

  it('flags extensionless relative static imports, re-exports, and dynamic imports', () => {
    const repoRoot = process.cwd();
    const fakeFile = path.join(repoRoot, 'shared', 'edgeAuthDomain.ts');
    const sample = `
      import {
        verifySecretHash,
      } from './authSecurity';
      export * from './subscriptionPlans';
      const mod = await import('./missingTarget.ts');
      import { createClient } from 'npm:@supabase/supabase-js@2';
    `;

    const violations = findRelativeImportViolationsInSource(sample, fakeFile, repoRoot);
    expect(violations).toHaveLength(3);
    expect(violations[0]).toContain('"./authSecurity" is missing an explicit ".ts" extension');
    expect(violations[1]).toContain('"./subscriptionPlans" is missing an explicit ".ts" extension');
    expect(violations[2]).toContain('"./missingTarget.ts" does not resolve to a file');
  });
});
