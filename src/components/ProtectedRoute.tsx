import { useEffect, useState, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type ProtectedRouteProps = {
  children: (user: User) => ReactNode;
};

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const [user, setUser] = useState<User | null>(null);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setIsChecking(false);
    });

    void supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      setIsChecking(false);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  if (isChecking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="sr-only">Verificando acesso</span>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return <>{children(user)}</>;
}