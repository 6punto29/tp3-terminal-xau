"use client";
// app/page.tsx — protegido con Supabase Auth

import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const LiveTerminal = dynamic(
  () => import("@/components/LiveTerminal"),
  { ssr: false, loading: () => (
    <div style={{ background:"#0B0D11", minHeight:"100vh", display:"flex",
      alignItems:"center", justifyContent:"center",
      fontFamily:"'JetBrains Mono',monospace", fontSize:13,
      color:"#5A6478", letterSpacing:2 }}>
      CARGANDO TERMINAL...
    </div>
  )}
);

export default function HomePage() {
  const router  = useRouter();
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        router.replace("/login");
      } else {
        setUserId(data.session.user.id);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) router.replace("/login");
      else setUserId(session.user.id);
    });

    return () => listener.subscription.unsubscribe();
  }, [router]);

  if (!userId) return (
    <div style={{ background:"#0B0D11", minHeight:"100vh", display:"flex",
      alignItems:"center", justifyContent:"center",
      fontFamily:"'JetBrains Mono',monospace", fontSize:13,
      color:"#5A6478", letterSpacing:2 }}>
      VERIFICANDO SESION...
    </div>
  );

  return <LiveTerminal userId={userId} />;
}
