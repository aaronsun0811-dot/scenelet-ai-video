import { useEffect, useMemo, useState, type ImgHTMLAttributes, type VideoHTMLAttributes } from "react";
import { API } from "@/api";
import { useAuthenticatedObjectUrl } from "@/hooks/useAuthenticatedObjectUrl";

type AuthenticatedImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "alt" | "src"> & {
  alt: string;
  src: string | null | undefined;
};

export function AuthenticatedImage({
  alt,
  src,
  referrerPolicy,
  ...props
}: AuthenticatedImageProps) {
  const resolvedSrc = useAuthenticatedObjectUrl(src);
  return (
    <img
      {...props}
      alt={alt}
      src={resolvedSrc}
      referrerPolicy={referrerPolicy ?? "no-referrer"}
    />
  );
}

type ProjectFileUrl = {
  cacheBust: string | null;
  path: string;
  projectName: string;
  sourceKey: string;
};

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseProjectFileUrl(src: string | null | undefined): ProjectFileUrl | null {
  if (!src) return null;

  let parsed: URL;
  try {
    parsed = new URL(src, window.location.origin);
  } catch {
    return null;
  }

  if (parsed.origin !== window.location.origin) return null;

  const prefix = "/api/v1/files/";
  if (!parsed.pathname.startsWith(prefix)) return null;

  const rest = parsed.pathname.slice(prefix.length);
  const firstSlash = rest.indexOf("/");
  if (firstSlash <= 0 || firstSlash >= rest.length - 1) return null;

  const projectName = safeDecode(rest.slice(0, firstSlash));
  const path = safeDecode(rest.slice(firstSlash + 1));
  if (!projectName || !path) return null;

  return {
    cacheBust: parsed.searchParams.get("v"),
    path,
    projectName,
    sourceKey: `${projectName}\0${path}\0${parsed.searchParams.get("v") ?? ""}`,
  };
}

function useSignedProjectFileUrl(src: string | null | undefined): string | undefined {
  const fileUrl = useMemo(() => parseProjectFileUrl(src), [src]);
  const [signed, setSigned] = useState<{ sourceKey: string; url: string } | null>(null);

  useEffect(() => {
    if (!fileUrl) return;

    let active = true;

    void API.requestFileAccessToken(fileUrl.projectName, fileUrl.path)
      .then(({ file_token }) => {
        if (!active) return;
        setSigned({
          sourceKey: fileUrl.sourceKey,
          url: API.getSignedFileUrl(fileUrl.projectName, fileUrl.path, file_token, fileUrl.cacheBust),
        });
      })
      .catch(() => {
        if (!active) return;
        setSigned(null);
      });

    return () => {
      active = false;
    };
  }, [fileUrl]);

  if (!fileUrl) return undefined;
  return signed?.sourceKey === fileUrl.sourceKey ? signed.url : undefined;
}

type AuthenticatedVideoProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, "poster" | "src"> & {
  poster?: string | null;
  src: string | null | undefined;
};

export function AuthenticatedVideo({
  poster,
  src,
  ...props
}: AuthenticatedVideoProps) {
  const isProjectFileSrc = useMemo(() => parseProjectFileUrl(src) !== null, [src]);
  const signedSrc = useSignedProjectFileUrl(src);
  const fallbackSrc = useAuthenticatedObjectUrl(isProjectFileSrc ? undefined : src);
  const resolvedPoster = useAuthenticatedObjectUrl(poster);
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- Generated preview media has no caption track.
    <video
      {...props}
      poster={resolvedPoster}
      src={signedSrc ?? fallbackSrc}
    />
  );
}
