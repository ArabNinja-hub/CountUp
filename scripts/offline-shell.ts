import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Produce a versioned worker containing only the static files in this build. */
export async function writeOfflineWorker(outDir: string, templatePath: string): Promise<void> {
  const files: string[] = [];
  async function visit(dir: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), name);
      else if (entry.isFile() && !['sw.js', '404.html', '.nojekyll'].includes(name))
        files.push(name);
    }
  }
  await visit(outDir);
  files.sort();
  if (!files.includes('index.html')) throw new Error('Cannot cache the app without index.html.');

  const template = await readFile(templatePath, 'utf8');
  const versionToken = '__COUNTUP_VERSION__';
  const filesToken = "'__COUNTUP_PRECACHE__'";
  if (!template.includes(versionToken) || !template.includes(filesToken)) {
    throw new Error('Offline worker template is missing its build placeholders.');
  }
  const manifest: { path: string; sha256: string }[] = [];
  for (const name of files) {
    const contents = await readFile(path.join(outDir, name));
    manifest.push({ path: name, sha256: createHash('sha256').update(contents).digest('hex') });
  }
  const serializedManifest = JSON.stringify(manifest);
  // Include both the worker logic and the unambiguous, sorted manifest so a
  // changed worker never shares a cache with the still-active old release.
  const version = createHash('sha256')
    .update(template)
    .update('\0')
    .update(serializedManifest)
    .digest('hex')
    .slice(0, 20);
  const worker = template.replace(versionToken, version).replace(filesToken, serializedManifest);
  await writeFile(path.join(outDir, 'sw.js'), worker, 'utf8');
}
