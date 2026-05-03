import { useEffect, useState } from "react";
import { Coins, KeyRound, Loader2, Power, RefreshCw, Search, Shield, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API, type AdminUserItem, type CreditBalanceResponse, type UpdateUserPayload } from "@/api";
import { useAppStore } from "@/stores/app-store";
import { errMsg } from "@/utils/async";

function formatDate(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function UserAdminSection() {
  const { t } = useTranslation(["dashboard"]);
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [creditLoadingUserId, setCreditLoadingUserId] = useState<string | null>(null);
  const [creditGrantingUserId, setCreditGrantingUserId] = useState<string | null>(null);
  const [creditByUserId, setCreditByUserId] = useState<Record<string, CreditBalanceResponse>>({});
  const [grantAmountByUserId, setGrantAmountByUserId] = useState<Record<string, string>>({});
  const [passwordByUserId, setPasswordByUserId] = useState<Record<string, string>>({});
  const [passwordUpdatingUserId, setPasswordUpdatingUserId] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "user">("user");
  const [creatingUser, setCreatingUser] = useState(false);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      API.listUsers(query.trim(), 50)
        .then((rows) => {
          if (!disposed) setUsers(rows);
        })
        .catch((err) => {
          if (!disposed) {
            setUsers([]);
            useAppStore.getState().pushToast(`${t("dashboard:users_load_failed")}${errMsg(err)}`, "error");
          }
        })
        .finally(() => {
          if (!disposed) setLoading(false);
        });
    }, 180);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [query, t]);

  const updateUser = async (user: AdminUserItem, payload: UpdateUserPayload) => {
    setUpdatingUserId(user.id);
    try {
      const updated = await API.updateUser(user.id, payload);
      setUsers((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      useAppStore.getState().pushToast(t("dashboard:users_updated"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:users_update_failed")}${errMsg(err)}`, "error");
    } finally {
      setUpdatingUserId(null);
    }
  };

  const loadUserCredits = async (user: AdminUserItem) => {
    setCreditLoadingUserId(user.id);
    try {
      const credits = await API.getUserCreditBalance(user.id);
      setCreditByUserId((current) => ({ ...current, [user.id]: credits }));
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:users_credit_load_failed")}${errMsg(err)}`, "error");
    } finally {
      setCreditLoadingUserId(null);
    }
  };

  const grantUserCredits = async (user: AdminUserItem) => {
    const amount = Number.parseInt(grantAmountByUserId[user.id] ?? "", 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      useAppStore.getState().pushToast(t("dashboard:users_grant_invalid"), "warning");
      return;
    }

    setCreditGrantingUserId(user.id);
    try {
      await API.grantCredits({
        amount,
        user_id: user.id,
        description: t("dashboard:users_grant_default_desc", { username: user.username }),
      });
      const credits = await API.getUserCreditBalance(user.id);
      setCreditByUserId((current) => ({ ...current, [user.id]: credits }));
      setGrantAmountByUserId((current) => ({ ...current, [user.id]: "" }));
      useAppStore.getState().pushToast(t("dashboard:users_grant_success"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:users_grant_failed")}${errMsg(err)}`, "error");
    } finally {
      setCreditGrantingUserId(null);
    }
  };

  const resetUserPassword = async (user: AdminUserItem) => {
    const password = (passwordByUserId[user.id] ?? "").trim();
    if (password.length < 8) {
      useAppStore.getState().pushToast(t("dashboard:users_password_invalid"), "warning");
      return;
    }

    setPasswordUpdatingUserId(user.id);
    try {
      const updated = await API.updateUser(user.id, { password });
      setUsers((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      setPasswordByUserId((current) => ({ ...current, [user.id]: "" }));
      useAppStore.getState().pushToast(t("dashboard:users_password_updated"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:users_password_failed")}${errMsg(err)}`, "error");
    } finally {
      setPasswordUpdatingUserId(null);
    }
  };

  const createUser = async () => {
    const username = newUsername.trim();
    if (!username || newPassword.length < 8) {
      useAppStore.getState().pushToast(t("dashboard:users_create_invalid"), "warning");
      return;
    }

    setCreatingUser(true);
    try {
      const created = await API.createUser({
        username,
        password: newPassword,
        role: newRole,
      });
      setUsers((current) => [created, ...current.filter((row) => row.id !== created.id)]);
      setNewUsername("");
      setNewPassword("");
      setNewRole("user");
      useAppStore.getState().pushToast(t("dashboard:users_create_success"), "success");
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:users_create_failed")}${errMsg(err)}`, "error");
    } finally {
      setCreatingUser(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-100">{t("dashboard:users_title")}</h2>
          <p className="mt-1 text-sm text-gray-500">{t("dashboard:users_desc")}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-300">
            {t("dashboard:users_count", { count: users.length })}
          </div>
        </div>
      </div>

      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
        <span className="sr-only">{t("dashboard:users_search")}</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("dashboard:users_search_placeholder")}
          className="w-full rounded-lg border border-gray-800 bg-gray-900 py-2 pl-9 pr-3 text-sm text-gray-100 placeholder:text-gray-600 focus-ring"
        />
      </label>

      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-200">
          <UserRound className="h-4 w-4 text-gray-500" />
          {t("dashboard:users_create_title")}
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem_auto]">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-500">{t("dashboard:users_create_username")}</span>
            <input
              value={newUsername}
              onChange={(event) => setNewUsername(event.target.value)}
              placeholder={t("dashboard:users_create_username_placeholder")}
              className="h-9 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-500">{t("dashboard:users_create_password")}</span>
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder={t("dashboard:users_create_password_placeholder")}
              className="h-9 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-500">{t("dashboard:users_role")}</span>
            <select
              value={newRole}
              onChange={(event) => setNewRole(event.target.value as "admin" | "user")}
              className="h-9 w-full rounded-lg border border-gray-700 bg-gray-950 px-3 text-sm text-gray-100 outline-none transition-colors focus:border-indigo-400"
            >
              <option value="user">{t("dashboard:users_role_user")}</option>
              <option value="admin">{t("dashboard:users_role_admin")}</option>
            </select>
          </label>
          <button
            type="button"
            onClick={() => { void createUser(); }}
            disabled={creatingUser || loading}
            className="inline-flex h-9 items-center justify-center gap-1.5 self-end rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-4 text-sm text-indigo-100 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creatingUser && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("dashboard:users_create_submit")}
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="hidden grid-cols-[minmax(0,1fr)_9rem_8rem_14rem_14rem] gap-3 border-b border-gray-800 px-4 py-3 text-xs font-medium uppercase text-gray-500 lg:grid">
          <div>{t("dashboard:users_user")}</div>
          <div>{t("dashboard:users_role")}</div>
          <div>{t("dashboard:users_status")}</div>
          <div>{t("dashboard:users_credit_ops")}</div>
          <div>{t("dashboard:users_password_ops")}</div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 px-4 py-8 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("dashboard:users_loading")}
          </div>
        ) : users.length === 0 ? (
          <div className="px-4 py-8 text-sm text-gray-500">{t("dashboard:users_empty")}</div>
        ) : (
          <div className="divide-y divide-gray-800">
            {users.map((user) => {
              const isUpdating = updatingUserId === user.id;
              const isCreditLoading = creditLoadingUserId === user.id;
              const isCreditGranting = creditGrantingUserId === user.id;
              const isPasswordUpdating = passwordUpdatingUserId === user.id;
              const credits = creditByUserId[user.id];
              const availableCredits = credits ? (credits.available_balance ?? credits.balance) : null;
              const reservedCredits = credits?.reserved_generation_credits ?? 0;
              return (
                <div key={user.id} className="grid grid-cols-1 gap-3 px-4 py-3 text-sm lg:grid-cols-[minmax(0,1fr)_9rem_8rem_14rem_14rem]">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-gray-100">
                      <UserRound className="h-4 w-4 shrink-0 text-gray-500" />
                      <span className="truncate font-medium">{user.username}</span>
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-gray-500">{user.id}</div>
                    <div className="mt-1 truncate text-xs text-gray-600">
                      {t("dashboard:users_created")}: {formatDate(user.created_at)}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 lg:block">
                    <span className="w-16 text-xs font-medium uppercase text-gray-500 lg:hidden">{t("dashboard:users_role")}</span>
                    <span className="relative inline-flex w-36 max-w-full items-center lg:w-full">
                      {user.role === "admin" && <Shield className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-indigo-300" />}
                      <select
                        value={user.role}
                        disabled={isUpdating}
                        aria-label={`${t("dashboard:users_role")} ${user.username}`}
                        onChange={(event) => { void updateUser(user, { role: event.target.value as "admin" | "user" }); }}
                        className={`h-9 w-full rounded-md border border-gray-700 bg-gray-950 py-1.5 pr-8 text-sm text-gray-100 focus-ring disabled:cursor-not-allowed disabled:opacity-60 ${
                          user.role === "admin" ? "pl-8" : "pl-3"
                        }`}
                      >
                        <option value="user">{t("dashboard:users_role_user")}</option>
                        <option value="admin">{t("dashboard:users_role_admin")}</option>
                      </select>
                    </span>
                  </label>
                  <div className="flex items-center gap-2 lg:block">
                    <span className="w-16 text-xs font-medium uppercase text-gray-500 lg:hidden">{t("dashboard:users_status")}</span>
                    <button
                      type="button"
                      disabled={isUpdating}
                      onClick={() => { void updateUser(user, { is_active: !user.is_active }); }}
                      className={`inline-flex h-9 w-36 max-w-full items-center justify-center gap-2 rounded-md border px-3 text-sm transition disabled:cursor-not-allowed disabled:opacity-60 lg:w-full ${
                        user.is_active
                          ? "border-emerald-700/60 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-900/40"
                          : "border-gray-700 bg-gray-950 text-gray-400 hover:bg-gray-800"
                      }`}
                      aria-label={
                        user.is_active
                          ? `${t("dashboard:users_deactivate")} ${user.username}`
                          : `${t("dashboard:users_activate")} ${user.username}`
                      }
                    >
                      {isUpdating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
                      {user.is_active ? t("dashboard:users_active") : t("dashboard:users_inactive")}
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-16 shrink-0 text-xs font-medium uppercase text-gray-500 lg:hidden">{t("dashboard:users_credit_ops")}</span>
                    <div className="min-w-0 flex-1 text-xs text-gray-400">
                      <div className="flex items-center gap-1.5">
                        <Coins className="h-3.5 w-3.5 text-amber-200" />
                        <span className="truncate">
                          {credits
                            ? t("dashboard:users_credit_available_balance", { count: (availableCredits ?? 0).toLocaleString() })
                            : t("dashboard:users_credit_unknown")}
                        </span>
                      </div>
                      {reservedCredits > 0 && (
                        <div className="mt-1 truncate text-sky-100/80">
                          {t("dashboard:users_credit_reserved", {
                            count: reservedCredits.toLocaleString(),
                          })}
                        </div>
                      )}
                      {credits && credits.pending_purchase_credits > 0 && (
                        <div className="mt-1 truncate text-amber-100/80">
                          {t("dashboard:users_credit_pending", {
                            count: credits.pending_purchase_credits.toLocaleString(),
                          })}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={grantAmountByUserId[user.id] ?? ""}
                        onChange={(event) =>
                          setGrantAmountByUserId((current) => ({
                            ...current,
                            [user.id]: event.target.value,
                          }))
                        }
                        placeholder={t("dashboard:users_grant_amount_placeholder")}
                        aria-label={t("dashboard:users_grant_amount_aria", { username: user.username })}
                        className="h-9 w-20 rounded-md border border-gray-700 bg-gray-950 px-2 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isCreditLoading || isCreditGranting}
                      />
                      <button
                        type="button"
                        onClick={() => { void loadUserCredits(user); }}
                        disabled={isCreditLoading || isCreditGranting}
                        aria-label={t("dashboard:users_check_balance_aria", { username: user.username })}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-700 bg-gray-950 text-gray-300 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isCreditLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => { void grantUserCredits(user); }}
                        disabled={isCreditLoading || isCreditGranting}
                        aria-label={t("dashboard:users_grant_aria", { username: user.username })}
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-amber-300/30 bg-amber-300/10 px-2.5 text-sm text-amber-100 transition hover:bg-amber-300/15 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isCreditGranting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Coins className="h-4 w-4" />}
                        {t("dashboard:users_grant")}
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-16 shrink-0 text-xs font-medium uppercase text-gray-500 lg:hidden">{t("dashboard:users_password_ops")}</span>
                    <input
                      type="password"
                      value={passwordByUserId[user.id] ?? ""}
                      onChange={(event) =>
                        setPasswordByUserId((current) => ({
                          ...current,
                          [user.id]: event.target.value,
                        }))
                      }
                      placeholder={t("dashboard:users_password_placeholder")}
                      aria-label={t("dashboard:users_password_aria", { username: user.username })}
                      className="h-9 min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-950 px-2 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isPasswordUpdating}
                    />
                    <button
                      type="button"
                      onClick={() => { void resetUserPassword(user); }}
                      disabled={isPasswordUpdating}
                      aria-label={t("dashboard:users_password_save_aria", { username: user.username })}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-indigo-300/30 bg-indigo-300/10 px-2.5 text-sm text-indigo-100 transition hover:bg-indigo-300/15 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isPasswordUpdating ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                      {t("dashboard:users_password_save")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
