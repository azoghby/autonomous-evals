import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readdir, readFile, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
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
        output = output.replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g, (all, prefix, quote, spec) => `${prefix}${quote}${/\.[a-z]+$/i.test(spec) ? spec : spec + (existsSync(resolve(from, spec, 'index.ts')) ? '/index.js' : '.js')}${quote}`);
        await writeFile(join(to, item.name.replace(/\.ts$/, '.js')), output);
      }
    }
  }
  try {
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const input = join(root, 'input'); await mkdir(input);
    execFileSync('tar', ['-x', '-C', input], { input: execFileSync('git', ['archive', '530af32067279497161c22ab00006247851d9200', 'packages/core/src/contracts'], { cwd: repo }) });
    await cp(join(repo,'packages/core/src'), join(input,'packages/core/src'), {recursive:true});
    await copy(join(input,'packages/core/src'), join(root,'src'));
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
