import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, Loader2, LockKeyhole, Mail } from "lucide-react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { AuthLayout } from "@/components/AuthLayout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

type Mode = "signin" | "signup" | "forgot";

const authErrorMessage = (message: string, code = "") => {
  const normalized = message.toLowerCase();
  const normalizedCode = code.toLowerCase();
  if (normalized.includes("email rate limit exceeded") || normalizedCode.includes("over_email_send_rate_limit")) {
    return "Muitas tentativas de envio para este e-mail. Aguarde alguns minutos antes de tentar novamente.";
  }
  if (normalized.includes("known to be weak") || normalized.includes("easy to guess")) {
    return "Esta senha é muito comum ou já apareceu em vazamentos. Escolha uma senha diferente e mais segura.";
  }
  if (normalized.includes("invalid login credentials")) return "E-mail ou senha incorretos.";
  if (normalized.includes("email not confirmed")) return "Confirme seu e-mail antes de entrar.";
  if (normalized.includes("already registered")) return "Este e-mail já possui uma conta.";
  if (normalized.includes("password")) return "A senha deve ter pelo menos 8 caracteres e não pode ser uma senha vazada.";
  return "Não foi possível concluir. Tente novamente.";
};

export default function Login() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSignedIn, setIsSignedIn] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsSignedIn(Boolean(session));
    });
    void supabase.auth.getSession().then(({ data }) => setIsSignedIn(Boolean(data.session)));
    return () => listener.subscription.unsubscribe();
  }, []);

  if (isSignedIn) return <Navigate to="/" replace />;

  const changeMode = (nextMode: Mode) => {
    setMode(nextMode);
    setError("");
    setNotice("");
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setIsLoading(true);

    try {
      if (mode === "forgot") {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (resetError) throw resetError;
        setNotice("Enviamos um link para redefinir sua senha. Verifique seu e-mail.");
        return;
      }

      if (mode === "signup" && password.length < 8) {
        setError("Use uma senha com pelo menos 8 caracteres.");
        return;
      }

      if (mode === "signup") {
        const { data, error: signupError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (signupError) throw signupError;
        if (!data.session) {
          setNotice("Conta criada. Confirme seu e-mail para entrar.");
          return;
        }
        navigate("/", { replace: true });
        return;
      }

      const { error: signinError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signinError) throw signinError;
      navigate("/", { replace: true });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "";
      const code = typeof caught === "object" && caught !== null && "code" in caught
        ? String(caught.code)
        : "";
      setError(authErrorMessage(message, code));
    } finally {
      setIsLoading(false);
    }
  };

  const title = mode === "signin" ? "Bem-vindo" : mode === "signup" ? "Criar conta" : "Recuperar senha";
  const description = mode === "signin"
    ? "Acesse com sua conta para continuar"
    : mode === "signup"
      ? "Cadastre seu e-mail para acessar o assistente"
      : "Receba por e-mail o link para criar uma nova senha";

  return (
    <AuthLayout title={title} description={description}>
          <form className="space-y-6" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="email">E-mail</Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="seu@email.com"
                  className="h-12 pl-10"
                  required
                />
              </div>
            </div>

            {mode !== "forgot" && (
              <div className="space-y-2">
                <Label htmlFor="password">Senha</Label>
                <div className="relative">
                  <LockKeyhole className="pointer-events-none absolute left-3.5 top-3.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Digite sua senha"
                    className="h-12 px-10"
                    required
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1 text-muted-foreground"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                  >
                    {showPassword ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                {mode === "signup" && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Use pelo menos 8 caracteres e evite senhas comuns ou já utilizadas em outros serviços.
                  </p>
                )}
              </div>
            )}

            {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">{error}</p>}
            {notice && <p className="rounded-md bg-secondary p-3 text-sm text-secondary-foreground" role="status">{notice}</p>}

            <Button type="submit" className="h-12 w-full text-base" disabled={isLoading}>
              {isLoading && <Loader2 className="animate-spin" />}
              {mode === "signin" ? "Entrar" : mode === "signup" ? "Criar conta" : "Enviar link"}
            </Button>
          </form>

          <div className="mt-7 space-y-3 text-center text-sm">
            {mode === "signin" && (
              <>
                <Button variant="link" className="h-auto p-0" onClick={() => changeMode("forgot")}>Esqueci minha senha</Button>
                <p className="text-muted-foreground">
                  Ainda não tem acesso?{" "}
                  <Button variant="link" className="h-auto p-0" onClick={() => changeMode("signup")}>Criar conta</Button>
                </p>
              </>
            )}
            {mode !== "signin" && (
              <Button variant="link" className="h-auto p-0" onClick={() => changeMode("signin")}>Voltar para entrar</Button>
            )}
          </div>
    </AuthLayout>
  );
}