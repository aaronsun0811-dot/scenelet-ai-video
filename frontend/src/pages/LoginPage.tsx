
import { useEffect, useState, type FormEvent } from "react";
import { useAutoFocus } from "@/hooks/useAutoFocus";
import { errMsg, voidPromise } from "@/utils/async";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/auth-store";
import { API } from "@/api";
import { LanguageSwitch } from "@/components/ui/LanguageSwitch";
import type { LoginResponse, ErrorResponse } from "@/api";

export function LoginPage() {
  const { t, i18n } = useTranslation(["common", "auth", "dashboard"]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [, setLocation] = useLocation();
  const login = useAuthStore((s) => s.login);
  const usernameRef = useAutoFocus<HTMLInputElement>();

  useEffect(() => {
    let cancelled = false;
    API.getAuthCapabilities()
      .then((caps) => {
        if (!cancelled) setRegistrationEnabled(caps.registration_enabled);
      })
      .catch(() => {
        if (!cancelled) setRegistrationEnabled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    if (mode === "register") {
      if (password.length < 8) {
        setError(t("auth:password_min_length"));
        return;
      }
      if (password !== confirmPassword) {
        setError(t("auth:password_mismatch"));
        return;
      }
    }

    setLoading(true);

    try {
      let data: LoginResponse;
      if (mode === "register") {
        data = await API.register({ username: username.trim(), password });
      } else {
        const body = new URLSearchParams({
          username,
          password,
          grant_type: "password",
        });
        const resp = await fetch("/api/v1/auth/token", {
          method: "POST",
          headers: {
            "Accept-Language": i18n.language || "zh",
          },
          body,
        });

        if (!resp.ok) {
          const respData = await resp.json().catch(() => ({})) as Partial<ErrorResponse>;
          const detail = respData.detail;
          throw new Error(typeof detail === "string" ? detail : t("auth:login_failed"));
        }

        data = await resp.json() as LoginResponse;
      }
      login(data.access_token, username);
      setLocation("/app/projects");
    } catch (err) {
      setError(errMsg(err, mode === "register" ? t("auth:register_failed") : t("auth:login_failed")));
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setMode((prev) => (prev === "login" ? "register" : "login"));
    setError("");
    setConfirmPassword("");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950">
      <div className="absolute right-5 top-5">
        <LanguageSwitch showLabel />
      </div>
      <div className="w-full max-w-sm rounded-xl border border-gray-800 bg-gray-900 p-8 shadow-2xl">
        <h1 className="mb-6 flex items-center justify-center gap-2 text-xl font-semibold text-gray-100">
          <img src="/scenelet-logo-192.png" alt={t("dashboard:app_title")} className="h-7 w-7" />
          <span>{t("dashboard:app_title")}</span>
        </h1>

        <form onSubmit={voidPromise(handleSubmit)} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("auth:username")}</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              ref={usernameRef}
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-gray-400">{t("auth:password")}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              required
            />
          </div>

          {mode === "register" && (
            <div>
              <label className="mb-1 block text-sm text-gray-400">{t("auth:confirm_password")}</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                required
              />
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {loading
              ? mode === "register" ? t("auth:registering") : t("auth:logging_in")
              : mode === "register" ? t("auth:register") : t("auth:login")}
          </button>
        </form>
        {registrationEnabled && (
          <button
            type="button"
            onClick={toggleMode}
            className="mt-4 w-full text-center text-sm text-indigo-300 transition-colors hover:text-indigo-200"
          >
            {mode === "register" ? t("auth:show_login") : t("auth:show_register")}
          </button>
        )}
      </div>
    </div>
  );
}
