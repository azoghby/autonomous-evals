/**
 * Turn a MediaAttachment spec into bytes:
 *   source "render"   → deterministic template (render.ts) — exact text, the default for documents
 *   source "generate" → gateway image model (photos) or gateway TTS (kind "audio")
 *   source "fixture"  → caller supplies bytes (not handled here)
 * Perturbations are applied after generation; injections are planted by render (documents) or the image prompt (photos).
 * Every result must then pass the media oracle (oracle.ts) before a scenario may use it.
 */
import type { MediaAttachment } from "../spec";
import type { MediaGateway } from "./client";
import { MEDIA_MODELS } from "./models";
import { renderDocument, type DocTemplate } from "./render";
import { perturbImage } from "./perturb";
import { speakAsPersona, type PersonaVoice } from "./tts";
import { planInjection, type InjectionPlan } from "./oracle";

export interface MaterializedMedia {
  attachmentId: string;
  kind: MediaAttachment["kind"];
  bytes: Uint8Array;
  mediaType: string;
  model?: string;
  template?: DocTemplate;
  injection?: InjectionPlan;
  perturbationsApplied: string[];
  microUsd: number;
}

const TEMPLATE_KEYWORDS: Array<[DocTemplate, RegExp]> = [
  ["id_card", /\b(id[_ -]?card|driver'?s? licen[cs]e|passport|identity)\b/i],
  ["invoice", /\binvoice\b/i],
  ["order_confirmation", /\b(order[_ -]?confirmation|screenshot|order confirmed|checkout)\b/i],
  ["receipt", /\breceipt\b/i],
];

/** Pick a render template from the attachment prompt ("template:invoice" wins, else keywords, else receipt). */
export function inferTemplate(prompt: string): DocTemplate {
  const explicit = /template:\s*(receipt|invoice|id_card|order_confirmation)/i.exec(prompt)?.[1];
  if (explicit) return explicit.toLowerCase() as DocTemplate;
  return TEMPLATE_KEYWORDS.find(([, re]) => re.test(prompt))?.[0] ?? "receipt";
}

/** Image-model prompt for photo attachments: the scene plus every ground-truth value spelled out so it is legible. */
export function photoPrompt(att: MediaAttachment, injection?: InjectionPlan): string {
  const facts = Object.entries(att.groundTruth).map(([k, v]) => `${k.replace(/_/g, " ")}: "${v}"`);
  const parts = [att.prompt.trim()];
  if (facts.length) parts.push(`The following text must be clearly legible in the image, exactly as written: ${facts.join("; ")}.`);
  if (injection) parts.push(`Somewhere small but legible (e.g. a sticky note or fine print), include the exact text: "${injection.text}".`);
  parts.push("Photorealistic, sharp focus, no watermarks.");
  return parts.join(" ");
}

export async function materializeAttachment(
  gw: MediaGateway,
  att: MediaAttachment,
  opts: { seed?: number; voice?: Partial<PersonaVoice>; imageModel?: string } = {},
): Promise<MaterializedMedia> {
  const injection = att.injection ? planInjection(att) : undefined;
  const base = { attachmentId: att.id, kind: att.kind, injection };

  if (att.kind === "audio") {
    if (att.source !== "generate") throw new Error(`audio attachment ${att.id}: only source "generate" (TTS) is supported`);
    const text = injection ? `${att.prompt} ${injection.text}` : att.prompt;
    const spoken = await speakAsPersona(gw, text, { ...opts.voice, ttsModel: att.model ?? opts.voice?.ttsModel });
    // Audio perturbations need ffmpeg in the Vercel Sandbox worker (perturb.ts) — not applied here.
    return { ...base, bytes: spoken.audio, mediaType: spoken.mediaType, model: spoken.model, perturbationsApplied: [], microUsd: spoken.microUsd };
  }
  if (att.kind === "video") throw new Error(`video attachment ${att.id}: video media is phase 3 (plan §7)`);

  let bytes: Uint8Array;
  let mediaType: string;
  let model: string | undefined;
  let template: DocTemplate | undefined;
  let microUsd = 0;
  if (att.source === "render") {
    template = inferTemplate(att.prompt);
    const doc = await renderDocument(template, att.groundTruth, injection ? { injection: { text: injection.text, style: injection.style } } : {});
    ({ png: bytes, mediaType } = doc);
  } else if (att.source === "generate") {
    model = att.model ?? opts.imageModel ?? MEDIA_MODELS.image.primary;
    const img = await gw.image({ model, prompt: photoPrompt(att, injection), seed: opts.seed });
    ({ image: bytes, mediaType } = img);
    microUsd = img.microUsd;
  } else {
    throw new Error(`attachment ${att.id}: fixture media must be supplied by the caller`);
  }

  const perturbed = att.perturbations.length ? await perturbImage(bytes, att.perturbations, { seed: opts.seed }) : undefined;
  return {
    ...base,
    bytes: perturbed?.bytes ?? bytes,
    mediaType: perturbed?.mediaType ?? mediaType,
    model,
    template,
    perturbationsApplied: perturbed?.applied ?? [],
    microUsd,
  };
}
