// ─────────────────────────────────────────────────────────────────────────────
// app/page.tsx
// Server Component — reads auth session, passes userId to client components.
// No Supabase keys leak to the browser through this pattern.
// ─────────────────────────────────────────────────────────────────────────────

import LiveTerminal from "@/components/LiveTerminal";

// ── Uncomment when auth is ready ──────────────────────────────────────────────
// import { createServerClient } from "@supabase/ssr";
// import { cookies } from "next/headers";
// async function getUserId(): Promise<string | null> {
//   const cookieStore = await cookies();
//   const supabase = createServerClient(
//     process.env.SUPABASE_URL!,
//     process.env.SUPABASE_ANON_KEY!,   // anon key is fine for auth cookie reads
//     { cookies: { get: (name) => cookieStore.get(name)?.value } }
//   );
//   const { data } = await supabase.auth.getUser();
//   return data.user?.id ?? null;
// }

export default async function HomePage() {
  // Replace with real userId from auth when ready
  const userId = "dev-user-001";

  return <LiveTerminal userId={userId} />;
}
