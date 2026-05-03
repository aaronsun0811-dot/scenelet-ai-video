import { create } from "zustand";
import { getToken, setToken as saveToken, clearToken } from "@/utils/auth";

interface AuthState {
  token: string | null;
  username: string | null;
  role: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  initialize: () => void;
  login: (token: string, username: string) => void;
  logout: () => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  username: null,
  role: null,
  isAuthenticated: false,
  isLoading: true,

  initialize: () => {
    const token = getToken();
    if (token) {
      const payload = parseJwtPayload(token);
      set({
        token,
        username: payload?.sub ?? null,
        role: payload?.role ?? null,
        isAuthenticated: true,
        isLoading: false,
      });
    } else {
      set({ isLoading: false });
    }
  },

  login: (token, username) => {
    saveToken(token);
    const payload = parseJwtPayload(token);
    set({ token, username, role: payload?.role ?? null, isAuthenticated: true, isLoading: false });
  },

  logout: () => {
    clearToken();
    set({ token: null, username: null, role: null, isAuthenticated: false });
  },

  setLoading: (isLoading) => set({ isLoading }),
}));

function parseJwtPayload(token: string): { sub?: string; role?: string } | null {
  const payload = token.split(".")[1];
  if (!payload) return null;

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(globalThis.atob(padded)) as { sub?: string; role?: string };
  } catch {
    return null;
  }
}
