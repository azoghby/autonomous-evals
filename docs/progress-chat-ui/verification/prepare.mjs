// Run from this directory after copying it to an isolated temporary fixture.
// Pass absolute artifact directory as argv[2]. No repo files are modified.
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const artifacts = resolve(process.argv[2]);
if (resolve(process.cwd()).startsWith(resolve(artifacts, '../..'))) throw new Error('Run prepare only in an isolated temporary directory.');
await mkdir('src/components/app', {recursive:true});
await mkdir('src/lib/client', {recursive:true});
await copyFile(`${artifacts}/component/job-progress-chat.tsx`, 'src/components/app/job-progress-chat.tsx');
await copyFile(`${artifacts}/component/progress-chat.ts`, 'src/lib/client/progress-chat.ts');
await writeFile('src/lib/client/api.ts', 'export const when = (value: string) => value;\n');
// UI interface doubles: component logic/accessibility is exercised, not Track A motion/Next rendering.
await writeFile('src/components/app/ui.tsx', `import { forwardRef, type ReactNode, type TextareaHTMLAttributes } from 'react';
export function Block({title,children}:{title?:string;children:ReactNode}) {return <section><h2>{title}</h2>{children}</section>}
export const Textarea=forwardRef<HTMLTextAreaElement,TextareaHTMLAttributes<HTMLTextAreaElement>>((props,ref)=><textarea {...props} ref={ref}/>);
`);
console.log('Prepared component fixture with explicit UI/date interface doubles.');
