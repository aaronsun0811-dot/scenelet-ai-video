import { useEffect, useMemo, useState } from "react";
import { getAuthHeader } from "@/utils/auth";

const SAFE_MEDIA_PROTOCOLS = new Set(["http:", "https:", "blob:", "data:"]);

function sanitizeMediaSrc(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  let url: URL;
  try {
    url = new URL(trimmed, window.location.origin);
  } catch {
    return undefined;
  }

  if (!SAFE_MEDIA_PROTOCOLS.has(url.protocol)) return undefined;
  if (url.protocol === "data:" && !/^data:(image|video)\//i.test(url.href)) return undefined;
  return trimmed;
}

function normalizeSameOriginApiUrl(src: string): { url: string; shouldFetchWithAuth: boolean } {
  const parsed = new URL(src, window.location.origin);
  const isSameOriginApi = parsed.origin === window.location.origin && parsed.pathname.startsWith("/api/");
  if (!isSameOriginApi) return { url: src, shouldFetchWithAuth: false };

  parsed.searchParams.delete("token");
  return {
    url: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    shouldFetchWithAuth: true,
  };
}

export function useAuthenticatedObjectUrl(src: string | null | undefined): string | undefined {
  const resolved = useMemo(() => {
    const sanitized = sanitizeMediaSrc(src);
    if (!sanitized) return { directUrl: undefined, fetchUrl: undefined };
    const { url, shouldFetchWithAuth } = normalizeSameOriginApiUrl(sanitized);
    const canFetchObjectUrl = typeof URL.createObjectURL === "function";
    const fetchUrl = shouldFetchWithAuth && getAuthHeader() && canFetchObjectUrl ? url : undefined;
    return { directUrl: fetchUrl ? undefined : url, fetchUrl };
  }, [src]);
  const [fetched, setFetched] = useState<{ fetchUrl: string; objectUrl: string } | null>(null);

  useEffect(() => {
    const { fetchUrl } = resolved;
    if (!fetchUrl) return;

    const authHeader = getAuthHeader();
    if (!authHeader) return;

    const controller = new AbortController();
    let objectUrl: string | undefined;
    let active = true;

    void fetch(fetchUrl, {
      headers: { Authorization: authHeader },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(response.statusText || "Failed to load media");
        return response.blob();
      })
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setFetched({ fetchUrl, objectUrl });
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setFetched(null);
      });

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [resolved]);

  if (resolved.fetchUrl) {
    return fetched?.fetchUrl === resolved.fetchUrl ? fetched.objectUrl : undefined;
  }
  return resolved.directUrl;
}
