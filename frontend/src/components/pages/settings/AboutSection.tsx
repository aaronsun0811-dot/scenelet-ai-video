import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Info, Loader2, RotateCcw, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { API } from "@/api";
import { useWarnUnsaved } from "@/hooks/useWarnUnsaved";
import { useAppStore } from "@/stores/app-store";
import type { GetSystemConfigResponse, SystemConfigPatch } from "@/types";
import { errMsg } from "@/utils/async";

interface AboutDraft {
  title: string;
  subtitle: string;
  body: string;
  contactLabel: string;
  contactUrl: string;
}

function buildDraft(data: GetSystemConfigResponse): AboutDraft {
  const settings = data.settings;
  return {
    title: settings.about_title ?? "",
    subtitle: settings.about_subtitle ?? "",
    body: settings.about_body ?? "",
    contactLabel: settings.about_contact_label ?? "",
    contactUrl: settings.about_contact_url ?? "",
  };
}

function draftsEqual(a: AboutDraft, b: AboutDraft): boolean {
  return (
    a.title === b.title
    && a.subtitle === b.subtitle
    && a.body === b.body
    && a.contactLabel === b.contactLabel
    && a.contactUrl === b.contactUrl
  );
}

function buildPatch(draft: AboutDraft, saved: AboutDraft): SystemConfigPatch {
  const patch: SystemConfigPatch = {};
  if (draft.title !== saved.title) patch.about_title = draft.title.trim();
  if (draft.subtitle !== saved.subtitle) patch.about_subtitle = draft.subtitle.trim();
  if (draft.body !== saved.body) patch.about_body = draft.body.trim();
  if (draft.contactLabel !== saved.contactLabel) patch.about_contact_label = draft.contactLabel.trim();
  if (draft.contactUrl !== saved.contactUrl) patch.about_contact_url = draft.contactUrl.trim();
  return patch;
}

const inputClassName =
  "w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-indigo-400";

function AboutPreview({ draft, emptyText }: { draft: AboutDraft; emptyText: string }) {
  if (!(draft.title || draft.subtitle || draft.body || (draft.contactLabel && draft.contactUrl))) {
    return <p className="text-sm text-gray-500">{emptyText}</p>;
  }

  return (
    <div className="space-y-4">
      {draft.title && <h3 className="text-2xl font-semibold text-white">{draft.title}</h3>}
      {draft.subtitle && <p className="text-sm text-gray-400">{draft.subtitle}</p>}
      {draft.body && (
        <div className="whitespace-pre-wrap text-sm leading-6 text-gray-200">
          {draft.body}
        </div>
      )}
      {draft.contactLabel && draft.contactUrl && (
        <a
          href={draft.contactUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-sky-300 transition-colors hover:text-sky-200"
        >
          {draft.contactLabel}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}

export function AboutSection() {
  const { t } = useTranslation("dashboard");
  const savedRef = useRef<AboutDraft>({
    title: "",
    subtitle: "",
    body: "",
    contactLabel: "",
    contactUrl: "",
  });
  const [draft, setDraft] = useState<AboutDraft>(savedRef.current);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const isDirty = useMemo(() => !draftsEqual(draft, savedRef.current), [draft]);
  useWarnUnsaved(isDirty);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    Promise.all([API.getSystemConfig(), API.verifyAuth()])
      .then(([res, auth]) => {
        if (disposed) return;
        const next = buildDraft(res);
        savedRef.current = next;
        setDraft(next);
        setIsAdmin(auth.role === "admin");
        setError(null);
      })
      .catch((err) => {
        if (!disposed) setError(errMsg(err));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const updateDraft = <K extends keyof AboutDraft>(key: K, value: AboutDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const handleReset = () => {
    setDraft(savedRef.current);
    setError(null);
  };

  const handleSave = async () => {
    const patch = buildPatch(draft, savedRef.current);
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await API.updateSystemConfig(patch);
      const next = buildDraft(res);
      savedRef.current = next;
      setDraft(next);
      useAppStore.getState().pushToast(t("about_admin_saved"), "success");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-900/40 p-6 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin text-indigo-300" />
        {t("about_admin_loading")}
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-100">
          {isAdmin ? t("about_admin_title") : t("about_public_title")}
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          {isAdmin ? t("about_admin_desc") : t("about_public_desc")}
        </p>
      </div>

      {isAdmin && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-gray-200">
            <Info className="h-4 w-4 text-indigo-200" />
            {t("about_admin_editor")}
          </div>
          <div className="grid gap-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500">{t("about_admin_field_title")}</span>
              <input
                value={draft.title}
                onChange={(event) => updateDraft("title", event.target.value)}
                placeholder={t("about_admin_field_title_placeholder")}
                className={inputClassName}
                disabled={saving}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500">{t("about_admin_field_subtitle")}</span>
              <input
                value={draft.subtitle}
                onChange={(event) => updateDraft("subtitle", event.target.value)}
                placeholder={t("about_admin_field_subtitle_placeholder")}
                className={inputClassName}
                disabled={saving}
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-500">{t("about_admin_field_body")}</span>
              <textarea
                value={draft.body}
                onChange={(event) => updateDraft("body", event.target.value)}
                placeholder={t("about_admin_field_body_placeholder")}
                className={`${inputClassName} min-h-40 resize-y leading-6`}
                disabled={saving}
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-500">{t("about_admin_field_contact_label")}</span>
                <input
                  value={draft.contactLabel}
                  onChange={(event) => updateDraft("contactLabel", event.target.value)}
                  placeholder={t("about_admin_field_contact_label_placeholder")}
                  className={inputClassName}
                  disabled={saving}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-500">{t("about_admin_field_contact_url")}</span>
                <input
                  value={draft.contactUrl}
                  onChange={(event) => updateDraft("contactUrl", event.target.value)}
                  placeholder="https://example.com/contact"
                  className={inputClassName}
                  disabled={saving}
                />
              </label>
            </div>
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {error}
            </div>
          )}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={handleReset}
              disabled={!isDirty || saving}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-gray-700 px-4 text-sm text-gray-300 transition-colors hover:bg-gray-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" />
              {t("about_admin_reset")}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!isDirty || saving}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-4 text-sm font-medium text-indigo-100 transition-colors hover:bg-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {t("about_admin_save")}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-5">
        <p className="mb-4 text-sm font-medium text-gray-200">
          {isAdmin ? t("about_admin_preview") : t("about_public_content")}
        </p>
        <AboutPreview draft={draft} emptyText={t(isAdmin ? "about_admin_empty_preview" : "about_public_empty")} />
      </div>
    </section>
  );
}
