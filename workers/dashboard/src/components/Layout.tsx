import { useEffect, useState, useCallback } from "react";
import { Outlet } from "react-router-dom";
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

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(collapsed));
    } catch {
      // storage unavailable
    }
  }, [collapsed]);

  const { demoMode } = useAuth();

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
  // Toggle collapsed on sidebar click (ignore clicks on links/buttons)
  // ---------------------------------------------------------------------------
  const handleSidebarClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      // If the click was on a link, button, or inside one, do nothing
      if (target.closest("a") || target.closest("button")) {
        return;
      }
      setCollapsed((prev) => !prev);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Derived sidebar width — expanded if not collapsed, or if hovered while collapsed
  // ---------------------------------------------------------------------------
  const showExpanded = !collapsed || hovered;
  const sidebarWidth = showExpanded
    ? SIDEBAR_WIDTH_EXPANDED
    : SIDEBAR_WIDTH_COLLAPSED;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex flex-col border-r bg-sidebar transition-[width] duration-200 ease-in-out",
        )}
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

      {/* Main content area offset by sidebar width */}
      <div
        className="flex flex-1 flex-col overflow-hidden transition-[margin-left] duration-200 ease-in-out"
        style={{ marginLeft: sidebarWidth }}
      >
        {demoMode && <DemoBanner />}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl p-6">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Chat widget */}
      <ChatSidebar />
    </div>
  );
}
