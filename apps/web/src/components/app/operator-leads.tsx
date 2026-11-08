"use client";
import { useFetch } from "@/lib/client/use-fetch";
import { when } from "@/lib/client/api";
import type { SalesLeadRow } from "@/server/sales-leads";
import { Frame } from "@/components/ui";
import { Empty, ErrorBox, Loading, Section, TableWrap, Th, tableCls, tdCls, trCls } from "./ui";

const truncate = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** Operator-only: latest enterprise leads (GET /api/operator/leads). */
export function OperatorLeads() {
  const { data, error, loading, reload } = useFetch<{ leads: SalesLeadRow[] }>("/api/operator/leads");
  return (
    <Section title="Enterprise leads">
      {loading ? <Loading label="Loading leads" /> : error || !data ? <ErrorBox message={error?.message ?? "Unknown error"} onRetry={reload} /> : (
        <Frame>
          {data.leads.length === 0 ? <Empty title="No leads yet" body="Submissions from /contact-sales appear here." /> : (
            <TableWrap>
              <table className={tableCls}>
                <thead><tr><Th>Created</Th><Th>Name</Th><Th>Company</Th><Th>Work email</Th><Th>Volume</Th><Th>Status</Th><Th>Agent</Th></tr></thead>
                <tbody>
                  {data.leads.map((l) => (
                    <tr key={l.id} className={trCls}>
                      <td className={tdCls}>{when(l.createdAt)}</td>
                      <td className={tdCls}>{l.name}</td>
                      <td className={tdCls}>{l.company}</td>
                      <td className={tdCls}><a className="underline-offset-4 hover:underline" href={`mailto:${l.workEmail}`}>{l.workEmail}</a></td>
                      <td className={tdCls}>{l.volume}</td>
                      <td className={tdCls}>{l.status}</td>
                      <td className={`${tdCls} max-w-xs`} title={l.agentDescription}>{truncate(l.agentDescription)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Frame>
      )}
    </Section>
  );
}
