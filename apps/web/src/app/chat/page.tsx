import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentCustomer } from "@/server/session";
import { TopBar } from "@/components/ui";
import { NovaChat } from "@/components/chat/NovaChat";

export const metadata: Metadata = { title: "Chat with Nova" };

const NAV = [
  { label: "Sandbox evals", href: "/sandbox" },
  { label: "New sandbox eval", href: "/sandbox/new" },
  { label: "Chat with Nova", href: "/chat" },
  { label: "My jobs", href: "/jobs" },
];

/** Roomy chat with Nova (onboarding / customer success): signed-in customers only. */
export default async function ChatPage() {
  const viewer = await getCurrentCustomer();
  if (!viewer) redirect("/signin?next=/chat");
  return (
    <div className="relative h-dvh overflow-hidden bg-bg text-fg">
      <TopBar nav={NAV} active="/chat" />
      <main id="main" tabIndex={-1} className="outline-none">
        <h1 className="sr-only">Chat with Nova</h1>
        <NovaChat variant="page" />
      </main>
    </div>
  );
}
