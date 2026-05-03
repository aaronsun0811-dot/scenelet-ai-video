const TOKEN_KEY = "scenelet_auth_token";
const LEGACY_TOKEN_KEY = "arcreel_auth_token";

export function getToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) return token;

  const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (legacyToken) {
    localStorage.setItem(TOKEN_KEY, legacyToken);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
  return legacyToken;
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

export function getAuthHeader(): string | null {
  const token = getToken();
  return token ? `Bearer ${token}` : null;
}
