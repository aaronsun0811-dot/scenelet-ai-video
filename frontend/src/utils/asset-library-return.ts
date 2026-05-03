const ASSET_LIBRARY_RETURN_TO_KEY = "assetLibrary:returnTo";

function isInternalAppPath(pathname: string | null): pathname is string {
  return Boolean(pathname && pathname.startsWith("/app/"));
}

export function rememberAssetLibraryReturnTo(pathname: string) {
  if (isInternalAppPath(pathname)) {
    sessionStorage.setItem(ASSET_LIBRARY_RETURN_TO_KEY, pathname);
  }
}

export function consumeAssetLibraryReturnTo(): string {
  const returnTo = sessionStorage.getItem(ASSET_LIBRARY_RETURN_TO_KEY);
  sessionStorage.removeItem(ASSET_LIBRARY_RETURN_TO_KEY);
  return isInternalAppPath(returnTo) ? returnTo : "/app/projects";
}
