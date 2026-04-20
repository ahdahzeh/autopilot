import { createClient } from "@/lib/supabase/server";
import { Dashboard } from "@/components/dashboard";
import { Landing } from "@/components/landing";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return <Landing />;
  return <Dashboard />;
}
