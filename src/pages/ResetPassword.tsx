import { useEffect, useState, type FormEvent } from "react";
import { Loader2, LockKeyhole } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { AuthLayout } from "@/components/AuthLayout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export default function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [isRecovery, setIsRecovery] = useState(window.location.hash.includes("type=recovery"));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setIsRecovery(true);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (password.length < 8) return setError("Use uma senha com pelo menos 8 caracteres.");
    if (password !== confirmation) return setError("As senhas não coincidem.");
    setIsLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setIsLoading(false);
    if (updateError) return setError("Não foi possível atualizar a senha. Solicite um novo link.");
    navigate("/", { replace: true });
  };

  return (
    <AuthLayout title="Definir nova senha" description="Crie uma nova senha para sua conta.">
          {!isRecovery ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-muted-foreground">Este link é inválido ou expirou.</p>
              <Button asChild variant="outline"><Link to="/login">Voltar para o acesso</Link></Button>
            </div>
          ) : (
            <form className="space-y-5" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <Label htmlFor="new-password">Nova senha</Label>
                <div className="relative">
                 <LockKeyhole className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-muted-foreground" />
                 <Input id="new-password" type="password" autoComplete="new-password" className="h-12 pl-10" value={password} onChange={(event) => setPassword(event.target.value)} required />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirmar nova senha</Label>
                <Input id="confirm-password" type="password" autoComplete="new-password" className="h-12" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
              </div>
              {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">{error}</p>}
              <Button type="submit" className="h-12 w-full text-base" disabled={isLoading}>
                {isLoading && <Loader2 className="animate-spin" />}
                Salvar nova senha
              </Button>
            </form>
          )}
    </AuthLayout>
  );
}