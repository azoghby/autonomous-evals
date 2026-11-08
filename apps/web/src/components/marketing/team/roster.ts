/** Single source for the "Meet the team" roster. Imported by the landing section and (later) /company. */

export type AgentStatus = "live" | "coming";
export type Department = "leadership" | "sales" | "evals" | "operations";
export type Tone = "accent" | "violet" | "cyan" | "ok" | "warn";
export type GlyphShape = "hex" | "diamond" | "ring" | "tri" | "square" | "notch";

export interface TeamAgent {
  id: string;
  name: string;
  role: string;
  department: Department;
  status: AgentStatus;
  /** First person, at most two short sentences. */
  bio: string;
  reportsTo: string;
  can: string;
  needsApproval: string;
  tone: Tone;
  shape: GlyphShape;
  /** Rendered larger in the grid. */
  featured?: boolean;
}

export const DEPARTMENTS: ReadonlyArray<{ id: Department; label: string; blurb: string }> = [
  { id: "leadership", label: "Leadership", blurb: "Sets the day's work." },
  { id: "sales", label: "Sales and growth", blurb: "Finds, quotes and courts customers." },
  { id: "evals", label: "Evals", blurb: "Designs, runs and grades every test." },
  { id: "operations", label: "Operations", blurb: "Keeps owners and runs moving." },
];

export const STATUS_LABEL: Record<AgentStatus, string> = { live: "Live", coming: "Coming online" };

export const ROSTER: ReadonlyArray<TeamAgent> = [
  {
    id: "cass", name: "Cass", role: "CEO / Planner", department: "leadership", status: "coming", featured: true,
    bio: "I read the metrics every morning and hand out the day's work. I plan; I do not improvise with money.",
    reportsTo: "Founder", can: "Read metrics, assign work to other agents.",
    needsApproval: "Spending beyond caps and anything that messages someone outside the company.",
    tone: "violet", shape: "hex",
  },
  {
    id: "cora", name: "Cora", role: "Commercial", department: "sales", status: "live", featured: true,
    bio: "I qualify incoming requests and put together the quote. The price comes from code, never from me.",
    reportsTo: "Cass", can: "Qualify requests, draft quotes from the price table.",
    needsApproval: "Anything off the price table.",
    tone: "accent", shape: "diamond",
  },
  {
    id: "mara", name: "Mara", role: "Market Researcher", department: "sales", status: "coming",
    bio: "I map who is building agents and what they worry about. Every claim I make links to a source.",
    reportsTo: "Cass", can: "Research the market from public information.", needsApproval: "Nothing external; I only read.",
    tone: "cyan", shape: "ring",
  },
  {
    id: "pax", name: "Pax", role: "Prospector", department: "sales", status: "coming",
    bio: "I build the list of teams worth talking to, from public sources only. I never contact anyone.",
    reportsTo: "Cass", can: "Compile prospect lists from public sources.", needsApproval: "Contacting anyone, ever.",
    tone: "ok", shape: "tri",
  },
  {
    id: "otto", name: "Otto", role: "Outreach", department: "sales", status: "coming",
    bio: "I write the emails, then wait. Nothing leaves my drafts folder until the founder says so.",
    reportsTo: "Cass", can: "Draft outreach emails.", needsApproval: "Every send.",
    tone: "warn", shape: "notch",
  },
  {
    id: "ezra", name: "Ezra", role: "Eval Designer", department: "evals", status: "live",
    bio: "You describe your agent and I turn it into a test suite. I care most about the cases you did not think of.",
    reportsTo: "Cass", can: "Design test suites from an agent description.", needsApproval: "Nothing; suites are graded before they ship.",
    tone: "violet", shape: "square",
  },
  {
    id: "sloane", name: "Sloane", role: "Scenario Writer", department: "evals", status: "live",
    bio: "I turn your tools, policies and workflows into sandbox scenarios. If a rule exists, I write a way to break it.",
    reportsTo: "Ezra", can: "Write sandbox scenarios.", needsApproval: "Nothing; scenarios run in a sandbox.",
    tone: "accent", shape: "hex",
  },
  {
    id: "remy", name: "Remy", role: "Customer Simulator", department: "evals", status: "live",
    bio: "I play the customer, sometimes sweet and sometimes a menace. Your agent meets me before it meets the real ones.",
    reportsTo: "Ezra", can: "Play realistic and adversarial customers in the sandbox.", needsApproval: "Nothing; I only talk to sandboxed agents.",
    tone: "cyan", shape: "diamond",
  },
  {
    id: "jude", name: "Jude", role: "Judge", department: "evals", status: "live",
    bio: "I grade the database state and the quality gates: oracle, null-agent and mutation. I do not grade on charm.",
    reportsTo: "Ezra", can: "Grade runs and block weak suites.", needsApproval: "Nothing; my gates are fixed in code.",
    tone: "warn", shape: "ring",
  },
  {
    id: "ines", name: "Ines", role: "Investigator", department: "evals", status: "live",
    bio: "I confirm a finding is real, then propose a fix with a before and after. If I cannot reproduce it, I say so.",
    reportsTo: "Jude", can: "Confirm findings, propose fixes.", needsApproval: "Nothing; fixes are proposals.",
    tone: "ok", shape: "tri",
  },
  {
    id: "wren", name: "Wren", role: "Report Writer", department: "evals", status: "live",
    bio: "I turn the results into a report a busy person can read. Short on adjectives, long on evidence.",
    reportsTo: "Ines", can: "Write reports from graded runs.", needsApproval: "Nothing.",
    tone: "violet", shape: "notch",
  },
  {
    id: "nova", name: "Nova", role: "Onboarding / Customer Success", department: "operations", status: "coming",
    bio: "I collect your specs, build your sandbox and start the first runs. You should never have to ask what happens next.",
    reportsTo: "Cass", can: "Collect specs, build sandboxes, start runs.", needsApproval: "Spend beyond the run caps.",
    tone: "accent", shape: "square",
  },
  {
    id: "olive", name: "Olive", role: "Owner Liaison", department: "operations", status: "live",
    bio: "I answer agent owners, handle verification, and send invites. The invites wait for approval.",
    reportsTo: "Cass", can: "Answer owners from a fixed set of tools, verify ownership.", needsApproval: "Invites.",
    tone: "cyan", shape: "hex",
  },
  {
    id: "lev", name: "Lev", role: "Leaderboard Runner", department: "operations", status: "live",
    bio: "I re-test public agents on a schedule so the board stays honest. I stop when the budget cap says so.",
    reportsTo: "Cass", can: "Re-run public agents on a schedule, under budget caps.", needsApproval: "Raising a cap.",
    tone: "ok", shape: "diamond",
  },
];

export const FOUNDER = {
  title: "Founder",
  tagline: "Human in the loop",
  body: "Final confirm on outreach, spend and anything irreversible.",
} as const;
