// Adapted helper: all core source comes from the composed stage, never the repository.
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
export async function stageCore(dependencies) {
  const ts = require(resolve(dependencies, 'typescript'));
  const root = await mkdtemp(join(tmpdir(), 'ae-provider-acceptance-'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await symlink(resolve(dependencies), join(root, 'node_modules'), 'dir');
  // Source paths are supplied independently of private provider configuration.
  async function copy(from, to) {
    await mkdir(to, { recursive: true });
    for (const item of await readdir(from, { withFileTypes: true })) {
      if (item.isDirectory()) await copy(join(from, item.name), join(to, item.name));
      else if (item.name.endsWith('.ts') && !item.name.endsWith('.test.ts')) {
        let output = ts.transpileModule(await readFile(join(from, item.name), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
        output = output.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g, (all, prefix, quote, spec) => `${prefix}${quote}${/\.[a-z]+$/i.test(spec) ? spec : spec + '.js'}${quote}`);
        await writeFile(join(to, item.name.replace(/\.ts$/, '.js')), output);
      }
    }
  }
  try {
    if (!process.env.WORKFLOW_STAGE) throw Error('WORKFLOW_STAGE required; repository core fallback refused');
    await copy(resolve(process.env.WORKFLOW_STAGE, 'packages/core/src'), join(root, 'src'));
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
