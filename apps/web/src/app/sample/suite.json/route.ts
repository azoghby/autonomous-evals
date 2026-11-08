import { sampleBundle } from "../sample-report";

export const dynamic = "force-static";

/** Downloadable sample report bundle (report, validated fixes, frozen suite). Fictional data. */
export function GET() {
  return new Response(JSON.stringify(sampleBundle, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="sample-suite.json"',
      "cache-control": "public, max-age=3600",
    },
  });
}
