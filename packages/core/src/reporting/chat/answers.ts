import type { ChatReply, ProgressSnapshot } from './types.js';

type Topic = ChatReply['topic'];

/** Classification affects presentation only; customer text never becomes answer content. */
function classify(question: string): Topic {
  const matches: Topic[] = [];
  if (/\b(progress|status|going|stage|milestone|eta|finish|finished|done|complete|completion|long|remaining|ready|happening)\b|\bhow soon\b/i.test(question)) matches.push('progress');
  if (/\b(cost|costs|spend|spent|spending|price|money|charge|charges|charged|billing|dollars|expensive)\b|\bhow much\b/i.test(question)) matches.push('cost');
  if (/\b(finding|findings|result|results|issue|issues|bug|bugs|discovered|found|find)\b/i.test(question)) matches.push('findings');
  if (/\b(blocker|blockers|blocked|stuck|error|errors|fail|failed|failure|waiting|paused|budget)\b/i.test(question)) matches.push('blockers');
  if (matches.length > 1 || /\b(overview|summary|summarize|update)\b/i.test(question)) return 'overview';
  return matches[0] ?? 'unknown';
}

function usd(microUsd: bigint): string {
  const fraction = (microUsd % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${microUsd / 1_000_000n}${fraction ? `.${fraction}` : '.00'}`;
}

/**
 * Pure, zero-spend answers from the validated, customer-safe persisted projection.
 * No customer question, evidence body, prompt, or provider response is interpolated.
 */
export function answerProgressQuestion(question: string, snapshot: ProgressSnapshot): ChatReply {
  const topic = classify(question);
  const evidenceRefs = new Set<string>([snapshot.statusEvidenceRef]);
  const unknowns = ['Completion time and ETA are unknown; no estimate is inferred from recorded progress.'];
  const paragraphs = [`Recorded job status: ${snapshot.status}.`];

  if (topic === 'progress' || topic === 'overview') {
    const latest = [...snapshot.milestones].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id))[0];
    if (latest) {
      paragraphs.push(`Latest recorded milestone: ${latest.milestone} at ${latest.at}. ${snapshot.milestones.length} milestone record(s) are available in this snapshot.`);
      evidenceRefs.add(latest.evidenceRef);
    } else {
      paragraphs.push('No milestone records are available in this snapshot.');
      unknowns.push('Milestone progress is unknown because no milestones were returned.');
    }
    unknowns.push('Current activity after the freshness timestamp and percentage complete are unknown.');
  }

  if (topic === 'cost' || topic === 'overview') {
    const total = snapshot.costs.reduce((sum, entry) => sum + BigInt(entry.microUsd), 0n);
    paragraphs.push(`Recorded known costs: USD ${usd(total)} across ${snapshot.costs.length} cost record(s). This covers persisted entries only.`);
    for (const entry of snapshot.costs) evidenceRefs.add(entry.evidenceRef);
    if (snapshot.costs.length === 0) unknowns.push('No cost entries were returned; actual incurred cost is unknown.');
    if (snapshot.unknownCosts) {
      paragraphs.push('Additional costs are explicitly marked unknown.');
      unknowns.push('Additional costs, including any unrecorded customer-provider or hosting costs, are unknown.');
    } else {
      unknowns.push('Costs not represented in the persisted cost ledger are not assessed.');
    }
    unknowns.push('Final total cost is unknown. Recorded evaluation costs are not a customer invoice.');
  }

  if (topic === 'findings' || topic === 'overview') {
    const confirmed = snapshot.findings.filter((finding) => finding.status === 'confirmed').length;
    const concerns = snapshot.findings.filter((finding) => finding.status === 'rubric_concern').length;
    const inconclusive = snapshot.findings.filter((finding) => finding.status === 'inconclusive').length;
    paragraphs.push(`Recorded findings: ${snapshot.findings.length} total; ${confirmed} confirmed, ${concerns} rubric concern(s), ${inconclusive} inconclusive.`);
    for (const finding of snapshot.findings) for (const ref of finding.evidenceRefs) evidenceRefs.add(ref);
    unknowns.push('Unrecorded findings and final evaluation results are unknown; zero recorded findings does not establish absence of problems.');
  }

  if (topic === 'blockers' || topic === 'overview') {
    const kinds = [...new Set(snapshot.blockers.map((blocker) => blocker.kind))].sort();
    paragraphs.push(snapshot.blockers.length
      ? `Recorded blockers: ${snapshot.blockers.length}; categories: ${kinds.join(', ')}.`
      : 'No blocker records are available in this snapshot. This does not establish that the evaluation is unblocked.');
    for (const blocker of snapshot.blockers) evidenceRefs.add(blocker.evidenceRef);
    unknowns.push('Unrecorded blockers, their resolution time, and any activity after the freshness timestamp are unknown.');
  }

  if (topic === 'unknown') {
    paragraphs.push('I can summarize persisted evaluation progress, known costs, findings, and blockers. This question cannot be answered from the available structured records.');
    unknowns.push('The requested information is not established by the available persisted records.');
  }

  return { asOf: snapshot.observedAt, topic, text: paragraphs.join('\n\n'), evidenceRefs: [...evidenceRefs], unknowns };
}
