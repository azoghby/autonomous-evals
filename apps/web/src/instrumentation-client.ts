import { initBotId } from "botid/client/core";

// Client-side BotID: attaches challenge headers to these fetches. Keep in sync with the
// routes that call assertHuman() (src/server/bot.ts).
initBotId({
  protect: [
    { path: "/api/auth/request-link", method: "POST" },
    { path: "/api/jobs", method: "POST" },
    { path: "/api/experts/signup", method: "POST" },
    { path: "/api/leaderboard/submit", method: "POST" },
    { path: "/api/sandbox/drafts", method: "POST" },
  ],
});
