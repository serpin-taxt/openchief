import { useEffect, useState, useCallback, useRef } from "react";
import { Outlet } from "react-router-dom";
import { Menu, X } from "lucide-react";
import type { AgentDefinition } from "@openchief/shared";
import { api, type ConnectionStatus, type CurrentUser } from "@/lib/api";
import { AppSidebar } from "@/components/AppSidebar";
import { ChatSidebar } from "@/components/ChatSidebar";
import { DemoBanner } from "@/components/DemoBanner";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const SIDEBAR_KEY = "openchief-sidebar-collapsed";
const SIDEBAR_WIDTH_EXPANDED = 256;
const SIDEBAR_WIDTH_COLLAPSED = 56;

/** Breakpoint (px) below which we use a mobile drawer instead of the fixed sidebar. */
const MOBILE_BREAKPOINT = 768;

export function Layout() {
  // ---------------------------------------------------------------------------
  // Sidebar state (persisted)
  // ---------------------------------------------------------------------------
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [hovered, setHovered] = useState(false);

  // Mobile drawer state
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT,
  );

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handler = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (!e.matches) setMobileOpen(false);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(collapsed));
    } catch {
      // storage unavailable
    }
  }, [collapsed]);

  const { demoMode, orgName } = useAuth();

  useEffect(() => {
    document.title = orgName ? `${orgName} - OpenChief` : "OpenChief";
  }, [orgName]);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [user, setUser] = useState<CurrentUser | null>(null);

  useEffect(() => {
    api.get<AgentDefinition[]>("agents").then(setAgents).catch(() => {});
    api
      .get<ConnectionStatus[]>("connections")
      .then(setConnections)
      .catch(() => {});
    api.get<CurrentUser>("me").then(setUser).catch(() => {});
  }, []);

  // ---------------------------------------------------------------------------
  // Desktop sidebar click toggle
  // ---------------------------------------------------------------------------
  const handleSidebarClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest("a") || target.closest("button")) return;
      setCollapsed((prev) => !prev);
    },
    [],
  );

  const handleMobileNav = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      // Only close drawer when an actual navigation link is clicked —
      // not when toggle buttons (Agents / Connections) are clicked.
      const target = e.target as HTMLElement;
      if (target.closest("a")) {
        setMobileOpen(false);
      }
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Mobile: auto-hide header on scroll down, show on scroll up
  // ---------------------------------------------------------------------------
  const mainRef = useRef<HTMLElement>(null);
  const [headerVisible, setHeaderVisible] = useState(true);
  const lastScrollY = useRef(0);

  useEffect(() => {
    if (!isMobile) return;
    const el = mainRef.current;
    if (!el) return;

    const onScroll = () => {
      const y = el.scrollTop;
      if (y > lastScrollY.current && y > 60) {
        // Scrolling down past threshold
        setHeaderVisible(false);
      } else if (y < lastScrollY.current) {
        // Scrolling up
        setHeaderVisible(true);
      }
      lastScrollY.current = y;
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [isMobile]);

  // ---------------------------------------------------------------------------
  // Derived sidebar width
  // ---------------------------------------------------------------------------
  const showExpanded = !collapsed || hovered;
  const sidebarWidth = showExpanded
    ? SIDEBAR_WIDTH_EXPANDED
    : SIDEBAR_WIDTH_COLLAPSED;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ── Mobile: overlay drawer ── */}
      {isMobile && (
        <>
          <div
            className={cn(
              "fixed inset-0 z-40 bg-black/60 transition-opacity duration-200",
              mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
            )}
            onClick={() => setMobileOpen(false)}
          />
          <aside
            className={cn(
              "fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col overflow-hidden border-r bg-sidebar transition-transform duration-200 ease-in-out",
              mobileOpen ? "translate-x-0" : "-translate-x-full",
            )}
            onClick={handleMobileNav}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMobileOpen(false);
              }}
              className="absolute top-3 right-3 rounded-md p-1 text-muted-foreground hover:text-foreground"
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
            <AppSidebar
              agents={agents}
              connections={connections}
              user={user}
              collapsed={false}
            />
          </aside>
        </>
      )}

      {/* ── Desktop: fixed sidebar ── */}
      {!isMobile && (
        <aside
          className="fixed inset-y-0 left-0 z-30 flex flex-col border-r bg-sidebar transition-[width] duration-200 ease-in-out"
          style={{ width: sidebarWidth }}
          onClick={handleSidebarClick}
          onMouseEnter={() => {
            if (collapsed) setHovered(true);
          }}
          onMouseLeave={() => setHovered(false)}
        >
          <AppSidebar
            agents={agents}
            connections={connections}
            user={user}
            collapsed={collapsed && !hovered}
          />
        </aside>
      )}

      {/* Main content area */}
      <div
        className="flex flex-1 flex-col overflow-hidden transition-[margin-left] duration-200 ease-in-out"
        style={{ marginLeft: isMobile ? 0 : sidebarWidth }}
      >
        {/* Desktop: demo banner (static, outside scroll) */}
        {!isMobile && demoMode && <DemoBanner className="shrink-0 border-b border-amber-500/20" />}

        <main ref={mainRef} className="flex-1 overflow-y-auto overflow-x-clip">
          {/* Mobile: sticky auto-hide header inside scroll container */}
          {isMobile && (
            <div
              className={cn(
                "sticky top-0 z-20 flex items-stretch border-b border-border bg-background transition-transform duration-200",
                headerVisible ? "translate-y-0" : "-translate-y-full",
              )}
            >
              <button
                onClick={() => setMobileOpen(true)}
                className="flex items-center justify-center w-11 shrink-0 border-r border-border bg-sidebar"
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5 text-sidebar-foreground" />
              </button>
              {demoMode ? (
                <DemoBanner className="flex-1 border-0" />
              ) : (
                <div className="flex-1" />
              )}
            </div>
          )}

          <div className="mx-auto max-w-6xl p-4 sm:p-6">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Chat widget */}
      <ChatSidebar />
    </div>
  );
}
