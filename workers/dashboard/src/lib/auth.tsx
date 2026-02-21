import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AuthProvider = "none" | "cloudflare-access" | "password";

interface AuthState {
  /** Has the initial session check completed? */
  checked: boolean;
  /** Is the current user authenticated? */
  authenticated: boolean;
  /** Which auth provider is active on the server? */
  provider: AuthProvider;
  /** Cloudflare Access team domain (for login redirect) */
  teamDomain: string | null;
  /** Is this a read-only demo instance? */
  demoMode: boolean;
  /** Is the user logged in as admin (demo mode)? */
  isAdmin: boolean;
}

interface AuthContextType extends AuthState {
  login: (password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthContextType | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    checked: false,
    authenticated: false,
    provider: "none",
    teamDomain: null,
    demoMode: false,
    isAdmin: false,
  });

  // Check session on mount
  useEffect(() => {
    fetch("/api/auth/session")
      .then((res) => res.json())
      .then(
        (data: {
          authenticated: boolean;
          provider: string;
          teamDomain?: string;
          demoMode?: boolean;
          isAdmin?: boolean;
        }) => {
          setState({
            checked: true,
            authenticated: data.authenticated,
            provider: data.provider as AuthProvider,
            teamDomain: data.teamDomain || null,
            demoMode: data.demoMode || false,
            isAdmin: data.isAdmin || false,
          });
        },
      )
      .catch(() => {
        // If session check fails, assume open access
        setState({
          checked: true,
          authenticated: true,
          provider: "none",
          teamDomain: null,
          demoMode: false,
          isAdmin: false,
        });
      });
  }, []);

  const login = useCallback(async (password: string) => {
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // Re-fetch session to pick up isAdmin and updated provider state
        const sessionRes = await fetch("/api/auth/session");
        const session = (await sessionRes.json().catch(() => ({}))) as {
          authenticated?: boolean;
          provider?: string;
          demoMode?: boolean;
          isAdmin?: boolean;
        };
        setState((prev) => ({
          ...prev,
          authenticated: true,
          isAdmin: session.isAdmin || false,
        }));
        return { ok: true };
      }
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      return { ok: false, error: data.error || "Invalid password" };
    } catch {
      return { ok: false, error: "Login failed" };
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setState((prev) => ({ ...prev, authenticated: false }));
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
