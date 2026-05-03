import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Coins, Copy, CreditCard, Loader2, RefreshCw, Terminal, ToggleLeft, ToggleRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { errMsg, voidPromise } from "@/utils/async";
import { getStripeSandboxAssist, setStripeSandboxAssist } from "@/utils/stripe-sandbox";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import type { CreditLedgerEntry, StripeBillingStatus } from "@/api";

const LOCAL_WEBHOOK_BASE = "http://127.0.0.1:1241";

function modeLabel(mode: StripeBillingStatus["mode"]) {
  if (mode === "test") return "Test";
  if (mode === "live") return "Live";
  return "Unknown";
}

function creditEntryCheckoutUrl(entry: CreditLedgerEntry) {
  const metadata = entry.metadata;
  if (!metadata || typeof metadata !== "object") return null;

  const url = metadata.stripe_checkout_url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

function canCancelCreditOrder(entry: CreditLedgerEntry) {
  const metadata = entry.metadata;
  const paymentMethod =
    metadata && typeof metadata === "object" && typeof metadata.payment_method === "string"
      ? metadata.payment_method
      : null;

  return !creditEntryCheckoutUrl(entry) && paymentMethod !== "stripe";
}

export function StripeSandboxSection() {
  const { t } = useTranslation(["common", "dashboard"]);
  const role = useAuthStore((s) => s.role);
  const canGrantCredits = role === "admin" || role === null;
  const [status, setStatus] = useState<StripeBillingStatus | null>(null);
  const [entries, setEntries] = useState<CreditLedgerEntry[]>([]);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const [reservedGenerationCredits, setReservedGenerationCredits] = useState(0);
  const [pendingPurchaseCredits, setPendingPurchaseCredits] = useState(0);
  const [loading, setLoading] = useState(false);
  const [sandboxAssist, setSandboxAssistState] = useState(getStripeSandboxAssist);
  const [confirmingOrderId, setConfirmingOrderId] = useState<string | null>(null);
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null);
  const [grantAmount, setGrantAmount] = useState("1000");
  const [grantDescription, setGrantDescription] = useState("");
  const [grantingCredits, setGrantingCredits] = useState(false);

  const webhookUrl = useMemo(
    () => `${LOCAL_WEBHOOK_BASE}${status?.webhook_path ?? "/api/v1/billing/stripe/webhook"}`,
    [status?.webhook_path],
  );
  const cliCommand = useMemo(
    () => `stripe listen --forward-to ${webhookUrl}`,
    [webhookUrl],
  );

  const loadStatus = async () => {
    setLoading(true);
    try {
      const [nextStatus, credits] = await Promise.all([
        API.getStripeBillingStatus(),
        API.getCreditBalance(),
      ]);
      setStatus(nextStatus);
      setEntries(credits.entries);
      setCreditBalance(credits.available_balance ?? credits.balance);
      setReservedGenerationCredits(credits.reserved_generation_credits ?? 0);
      setPendingPurchaseCredits(credits.pending_purchase_credits);
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:stripe_status_load_failed")}${errMsg(err)}`, "warning");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = async (value: string) => {
    await navigator.clipboard?.writeText(value);
    useAppStore.getState().pushToast(t("common:copied"), "success");
  };

  const toggleSandboxAssist = () => {
    const next = !sandboxAssist;
    setStripeSandboxAssist(next);
    setSandboxAssistState(next);
  };
  const pendingOrders = entries.filter(
    (entry) =>
      entry.kind === "purchase" &&
      entry.status === "pending" &&
      entry.reference_type === "credit_order" &&
      entry.reference_id,
  );

  const sandboxConfirm = async (orderId: string) => {
    setConfirmingOrderId(orderId);
    try {
      await API.sandboxConfirmCreditOrder(orderId);
      useAppStore.getState().pushToast(t("dashboard:stripe_sandbox_confirmed"), "success");
      await loadStatus();
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:stripe_sandbox_confirm_failed")}${errMsg(err)}`, "error");
    } finally {
      setConfirmingOrderId(null);
    }
  };

  const cancelOrder = async (orderId: string) => {
    setCancellingOrderId(orderId);
    try {
      await API.cancelCreditOrder(orderId);
      useAppStore.getState().pushToast(t("dashboard:credit_order_cancelled"), "success");
      await loadStatus();
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:credit_order_cancel_failed")}${errMsg(err)}`, "error");
    } finally {
      setCancellingOrderId(null);
    }
  };

  const grantCredits = async () => {
    const amount = Number.parseInt(grantAmount, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      useAppStore.getState().pushToast(t("dashboard:manual_credit_grant_invalid"), "warning");
      return;
    }
    setGrantingCredits(true);
    try {
      await API.grantCredits({
        amount,
        description: grantDescription.trim() || t("dashboard:manual_credit_grant_default_desc"),
      });
      useAppStore.getState().pushToast(t("dashboard:manual_credit_grant_success"), "success");
      setGrantDescription("");
      await loadStatus();
    } catch (err) {
      useAppStore.getState().pushToast(`${t("dashboard:manual_credit_grant_failed")}${errMsg(err)}`, "error");
    } finally {
      setGrantingCredits(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-100">{t("dashboard:stripe_sandbox_title")}</h2>
        <p className="mt-1 text-sm text-gray-500">{t("dashboard:stripe_sandbox_desc")}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <CreditCard className="h-4 w-4" />
            {t("dashboard:stripe_config_status")}
          </div>
          <div className="mt-3 flex items-center gap-2">
            {status?.configured ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-300" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-300" />
            )}
            <span className="text-base font-semibold text-gray-100">
              {status?.configured ? t("dashboard:stripe_configured") : t("dashboard:stripe_not_configured")}
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <div className="text-sm text-gray-400">{t("dashboard:stripe_key_mode")}</div>
          <div className="mt-3 text-base font-semibold text-gray-100">
            {status ? modeLabel(status.mode) : "—"}
          </div>
        </div>

        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <div className="text-sm text-gray-400">{t("dashboard:stripe_webhook_path")}</div>
          <div className="mt-3 truncate font-mono text-xs text-gray-200">
            {status?.webhook_path ?? "/api/v1/billing/stripe/webhook"}
          </div>
        </div>

        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Coins className="h-4 w-4" />
            {t("dashboard:credit_current_balance")}
          </div>
          <div className="mt-3 text-base font-semibold text-gray-100">
            {t("dashboard:credits_count", {
              count: creditBalance == null ? "—" : creditBalance.toLocaleString(),
            })}
          </div>
          {pendingPurchaseCredits > 0 && (
            <div className="mt-1 text-xs text-amber-100/80">
              {t("dashboard:credit_pending_purchase", { count: pendingPurchaseCredits.toLocaleString() })}
            </div>
          )}
          {reservedGenerationCredits > 0 && (
            <div className="mt-1 text-xs text-sky-100/80">
              {t("dashboard:credit_reserved_generation", { count: reservedGenerationCredits.toLocaleString() })}
            </div>
          )}
        </div>
      </div>

      {status && !status.configured && (
        <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm text-amber-100">
          <div className="font-medium">{t("dashboard:stripe_missing_title")}</div>
          <div className="mt-1 text-amber-100/80">
            {t("dashboard:stripe_missing_env", { names: status.missing.join(", ") })}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-100">{t("dashboard:stripe_sandbox_assist")}</h3>
            <p className="mt-1 text-sm leading-6 text-gray-500">
              {t("dashboard:stripe_sandbox_assist_desc")}
            </p>
          </div>
          <button
            type="button"
            onClick={toggleSandboxAssist}
            aria-label={t("dashboard:stripe_sandbox_assist")}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
              sandboxAssist
                ? "border-indigo-400/40 bg-indigo-500/10 text-indigo-100"
                : "border-gray-700 bg-gray-950 text-gray-400 hover:border-gray-600"
            }`}
          >
            {sandboxAssist ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
            {sandboxAssist ? t("dashboard:enabled") : t("dashboard:disabled")}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <div>
          <h3 className="text-base font-semibold text-gray-100">{t("dashboard:stripe_sandbox_orders")}</h3>
          <p className="mt-1 text-sm leading-6 text-gray-500">
            {status?.sandbox_tools_enabled
              ? t("dashboard:stripe_sandbox_orders_desc_enabled")
              : t("dashboard:stripe_sandbox_orders_desc_disabled")}
          </p>
        </div>

        <div className="mt-4">
          {pendingOrders.length === 0 ? (
            <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-4 py-5 text-center text-sm text-gray-500">
              {t("dashboard:stripe_sandbox_no_pending_orders")}
            </div>
          ) : (
            <div className="divide-y divide-gray-800 overflow-hidden rounded-lg border border-gray-800 bg-gray-950/50">
              {pendingOrders.map((entry) => {
                const orderId = entry.reference_id ?? "";
                const checkoutUrl = creditEntryCheckoutUrl(entry);
                return (
                  <div key={entry.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs text-gray-300">{orderId}</div>
                      <div className="mt-1 text-xs text-gray-500">
                        +{entry.amount.toLocaleString()} · {t("dashboard:credit_status_pending")}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {checkoutUrl && (
                        <button
                          type="button"
                          onClick={() => window.location.assign(checkoutUrl)}
                          className="inline-flex items-center justify-center rounded-lg border border-amber-300/30 px-3 py-2 text-sm font-medium text-amber-100 transition-colors hover:bg-amber-300/10"
                        >
                          {t("dashboard:continue_payment")}
                        </button>
                      )}
                      {canCancelCreditOrder(entry) && (
                        <button
                          type="button"
                          onClick={voidPromise(() => cancelOrder(orderId))}
                          disabled={cancellingOrderId !== null || confirmingOrderId !== null}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 transition-colors hover:border-red-300/40 hover:bg-red-500/10 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {cancellingOrderId === orderId && <Loader2 className="h-4 w-4 animate-spin" />}
                          {t("dashboard:credit_order_cancel")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={voidPromise(() => sandboxConfirm(orderId))}
                        disabled={!status?.sandbox_tools_enabled || confirmingOrderId !== null || cancellingOrderId !== null}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-100 transition-colors hover:border-indigo-300/50 hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {confirmingOrderId === orderId && <Loader2 className="h-4 w-4 animate-spin" />}
                        {t("dashboard:stripe_sandbox_confirm_order")}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {canGrantCredits && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-300/10 text-amber-200">
              <Coins className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-gray-100">{t("dashboard:manual_credit_grant")}</h3>
              <p className="mt-1 text-sm leading-6 text-gray-500">{t("dashboard:manual_credit_grant_desc")}</p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-[160px_1fr_auto]">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500">{t("dashboard:manual_credit_grant_amount")}</span>
              <input
                type="number"
                min={1}
                step={1}
                value={grantAmount}
                onChange={(e) => setGrantAmount(e.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-indigo-400"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500">{t("dashboard:manual_credit_grant_reason")}</span>
              <input
                type="text"
                value={grantDescription}
                onChange={(e) => setGrantDescription(e.target.value)}
                placeholder={t("dashboard:manual_credit_grant_default_desc")}
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400"
              />
            </label>
            <button
              type="button"
              onClick={voidPromise(grantCredits)}
              disabled={grantingCredits}
              className="inline-flex items-center justify-center gap-1.5 self-end rounded-lg border border-amber-300/30 bg-amber-300/10 px-4 py-2 text-sm text-amber-100 transition-colors hover:border-amber-200/50 hover:bg-amber-300/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {grantingCredits && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("dashboard:manual_credit_grant_submit")}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-gray-400" />
            <h3 className="text-base font-semibold text-gray-100">{t("dashboard:stripe_cli_title")}</h3>
          </div>
          <button
            type="button"
            onClick={voidPromise(() => loadStatus())}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-300 transition-colors hover:border-gray-500 hover:text-white"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("common:refresh")}
          </button>
        </div>
        <p className="mt-2 text-sm leading-6 text-gray-500">{t("dashboard:stripe_cli_desc")}</p>

        <div className="mt-4 space-y-3">
          <CodeRow label={t("dashboard:stripe_webhook_url")} value={webhookUrl} onCopy={copy} />
          <CodeRow label={t("dashboard:stripe_cli_command")} value={cliCommand} onCopy={copy} />
          <CodeRow
            label={t("dashboard:stripe_env_example")}
            value={"STRIPE_SECRET_KEY=sk_test_...\nSTRIPE_WEBHOOK_SECRET=whsec_..."}
            onCopy={copy}
            multiline
          />
        </div>
      </div>
    </div>
  );
}

function CodeRow({
  label,
  value,
  multiline = false,
  onCopy,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  onCopy: (value: string) => Promise<void>;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase text-gray-500">{label}</div>
      <div className="flex items-stretch overflow-hidden rounded-lg border border-gray-800 bg-gray-950">
        <pre className={`min-w-0 flex-1 overflow-x-auto px-3 py-2 font-mono text-xs text-gray-300 ${multiline ? "whitespace-pre" : "whitespace-nowrap"}`}>
          {value}
        </pre>
        <button
          type="button"
          onClick={voidPromise(() => onCopy(value))}
          className="border-l border-gray-800 px-3 text-gray-500 transition-colors hover:bg-gray-800 hover:text-gray-200"
          aria-label="copy"
        >
          <Copy className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
