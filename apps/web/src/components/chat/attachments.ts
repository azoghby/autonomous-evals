/** Reads dropped/picked files into validated chat attachments (client side; the route re-validates). */
import {
  ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, attachmentProblem, classifyAttachment, MAX_ATTACHMENTS, type AttachmentKind, type ChatAttachment,
} from "./nova-types";

const EXTENSIONS = ATTACHMENT_ACCEPT.split(",");
const LARGEST = Math.max(...Object.values(ATTACHMENT_MAX_BYTES));

export interface ReadResult { files: ChatAttachment[]; errors: string[] }

/** Detects the kind, falling back to policies for prose files. Null when it's none of the four. */
export function kindFor(name: string, content: string): AttachmentKind | null {
  return classifyAttachment(name, content) ?? (/\.(md|txt)$/i.test(name) ? "policies" : null);
}

export async function readAttachments(list: FileList | File[], already = 0): Promise<ReadResult> {
  const files: ChatAttachment[] = [];
  const errors: string[] = [];
  for (const f of Array.from(list)) {
    if (already + files.length >= MAX_ATTACHMENTS) { errors.push(`At most ${MAX_ATTACHMENTS} files per message.`); break; }
    if (!EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext))) { errors.push(`${f.name}: use ${EXTENSIONS.join(" ")} files.`); continue; }
    if (f.size > LARGEST) { errors.push(`${f.name} is ${Math.ceil(f.size / 1000)} KB; the limit is ${LARGEST / 1000} KB.`); continue; }
    let content: string;
    try { content = await f.text(); } catch { errors.push(`${f.name} could not be read.`); continue; }
    const kind = kindFor(f.name, content);
    if (!kind) { errors.push(`${f.name} isn't an OpenAPI spec, MCP tool list, CREATE TABLE schema or policy text.`); continue; }
    const a = { kind, name: f.name.slice(0, 200), content };
    const problem = attachmentProblem(a);
    if (problem) { errors.push(problem); continue; }
    files.push(a);
  }
  return { files, errors };
}
