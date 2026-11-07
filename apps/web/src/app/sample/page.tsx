import type { Metadata } from "next";
import { SampleReport } from "./SampleReport";

export const metadata: Metadata = {
  title: "Sample report · Autonomous Evals",
  description: "A sample Trace Audit report for a fictional agent: findings with evidence, validated fixes, and how pricing works.",
};

export default function SamplePage() {
  return <SampleReport />;
}
