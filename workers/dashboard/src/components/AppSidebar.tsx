import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Bot,
  Home,
  Users,
  CalendarClock,
  Cpu,
  Cable,
  LogOut,
  ChevronRight,
  Crown,
  DollarSign,
  Shield,
  Wrench,
  BarChart3,
  Megaphone,
  Handshake,
  Heart,
  Crosshair,
  Headset,
  Scale,
  TrendingUp,
  FlaskConical,
  Palette,
  Wand2,
  ListTodo,
} from "lucide-react";
import type { AgentDefinition } from "@openchief/shared";
import type { ConnectionStatus, CurrentUser } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { SourceIcon } from "@/components/SourceIcon";

// ---------------------------------------------------------------------------
// Agent icon map
// ---------------------------------------------------------------------------

const AGENT_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "ceo": Crown,
  "cfo": DollarSign,
  "ciso": Shield,
  "eng-manager": Wrench,
  "data-analyst": BarChart3,
  "marketing-manager": Megaphone,
  "bizdev": Handshake,
  "cpo": Heart,
  "product-manager": Crosshair,
  "customer-support": Headset,
  "legal-counsel": Scale,
  "cro": TrendingUp,
  "researcher": FlaskConical,
  "design-manager": Palette,
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NavItem({
  to,
  icon,
  label,
  active,
  collapsed,
  trailing,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  active: boolean;
  collapsed: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        collapsed ? "justify-center" : "",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
      )}
    >
      <span className="shrink-0">{icon}</span>
      {!collapsed && <span className="truncate">{label}</span>}
      {trailing}
    </Link>
  );
}

function NavToggle({
  icon,
  label,
  open,
  onToggle,
  collapsed,
  childActive,
}: {
  icon: React.ReactNode;
  label: string;
  open: boolean;
  onToggle: () => void;
  collapsed: boolean;
  childActive: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      title={collapsed ? label : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        collapsed ? "justify-center" : "",
        childActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
      )}
    >
      <span className="shrink-0">{icon}</span>
      {!collapsed && (
        <>
          <span className="truncate">{label}</span>
          <ChevronRight
            className={cn(
              "ml-auto h-3.5 w-3.5 text-muted-foreground/50 transition-transform duration-200",
              open ? "rotate-90" : "",
            )}
          />
        </>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// AppSidebar
// ---------------------------------------------------------------------------

interface AppSidebarProps {
  agents: AgentDefinition[];
  connections: ConnectionStatus[];
  user: CurrentUser | null;
  collapsed: boolean;
}

export function AppSidebar({
  agents,
  connections,
  user,
  collapsed,
}: AppSidebarProps) {
  const location = useLocation();
  const { provider, logout, orgName, role } = useAuth();

  const isExecOrAbove = role === "superadmin" || role === "exec";
  const isSuperadmin = role === "superadmin";

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + "/");

  const execAgents = agents.filter((a) => a.visibility === "exec");
  const teamAgents = agents.filter((a) => a.visibility !== "exec");

  const anyAgentActive = agents.some((a) => isActive(`/agents/${a.id}`));
  const anyConnectionActive = connections.some((c) => isActive(`/connections/${c.source}`));

  const [agentsOpen, setAgentsOpen] = useState(
    () => anyAgentActive,
  );
  const [connectionsOpen, setConnectionsOpen] = useState(
    () => anyConnectionActive,
  );

  // Derive initials from user
  const initials = user?.displayName
    ? user.displayName
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : user?.email?.slice(0, 2).toUpperCase() ?? "?";

  return (
    <>
      {/* Header */}
      <div
        className="flex h-14 shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b px-4"
      >
        <svg className="h-6 w-6 shrink-0 text-sidebar-primary" viewBox="6 12 52 42" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 44C10 44 18 50 32 50C46 50 54 44 54 44" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          <path d="M10 44L14 22L24 36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M54 44L50 22L40 36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M24 36L32 16L40 36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        <span
          className={cn(
            "text-lg font-semibold tracking-tight text-sidebar-foreground transition-opacity duration-200",
            collapsed ? "opacity-0" : "opacity-100",
          )}
        >
          {orgName || "OpenChief"}
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        <NavItem
          to="/"
          icon={<Home className="h-4 w-4" />}
          label="Home"
          active={location.pathname === "/"}
          collapsed={collapsed}
        />

        {/* Agents — toggleable */}
        <NavToggle
          icon={<Bot className="h-4 w-4" />}
          label="Agents"
          open={agentsOpen}
          onToggle={() => setAgentsOpen((o) => !o)}
          collapsed={collapsed}
          childActive={anyAgentActive}
        />
        {agentsOpen && !collapsed && (
          <div className="ml-4">
            {isExecOrAbove && execAgents.length > 0 && (
              <>
                <p className="mb-0.5 mt-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-amber-500/70">
                  Exec
                </p>
                {execAgents.map((agent) => {
                  const Icon = AGENT_ICONS[agent.id] || Bot;
                  return (
                    <NavItem
                      key={agent.id}
                      to={`/agents/${agent.id}`}
                      icon={<Icon className="h-4 w-4" />}
                      label={agent.name}
                      active={isActive(`/agents/${agent.id}`)}
                      collapsed={collapsed}
                    />
                  );
                })}
              </>
            )}
            {teamAgents.length > 0 && isExecOrAbove && execAgents.length > 0 && (
              <p className="mb-0.5 mt-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                Team
              </p>
            )}
            {teamAgents.map((agent) => {
              const Icon = AGENT_ICONS[agent.id] || Bot;
              return (
                <NavItem
                  key={agent.id}
                  to={`/agents/${agent.id}`}
                  icon={<Icon className="h-4 w-4" />}
                  label={agent.name}
                  active={isActive(`/agents/${agent.id}`)}
                  collapsed={collapsed}
                />
              );
            })}
            {agents.length === 0 && (
              <p className="px-2 py-1 text-xs text-muted-foreground">No agents yet</p>
            )}
          </div>
        )}

        <NavItem
          to="/team"
          icon={<Users className="h-4 w-4" />}
          label="Humans"
          active={isActive("/team")}
          collapsed={collapsed}
        />
        <NavItem
          to="/tasks"
          icon={<ListTodo className="h-4 w-4" />}
          label="Tasks"
          active={isActive("/tasks")}
          collapsed={collapsed}
        />

        {/* Connections — superadmin only */}
        {isSuperadmin && (
          <>
            <NavToggle
              icon={<Cable className="h-4 w-4" />}
              label="Connections"
              open={connectionsOpen}
              onToggle={() => setConnectionsOpen((o) => !o)}
              collapsed={collapsed}
              childActive={anyConnectionActive}
            />
            {connectionsOpen && !collapsed && (
              <div className="ml-4">
                {connections.map((conn) => (
                  <NavItem
                    key={conn.source}
                    to={`/connections/${conn.source}`}
                    icon={<SourceIcon name={conn.source} className="h-4 w-4" />}
                    label={conn.label}
                    active={isActive(`/connections/${conn.source}`)}
                    collapsed={collapsed}
                    trailing={
                      !collapsed ? (
                        <span
                          className={cn(
                            "ml-auto inline-block h-2 w-2 rounded-full",
                            conn.lastEventAt ? "bg-emerald-400" : "bg-muted",
                          )}
                        />
                      ) : undefined
                    }
                  />
                ))}
                {connections.length === 0 && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No connections</p>
                )}
              </div>
            )}
            <NavItem
              to="/tools"
              icon={<Wand2 className="h-4 w-4" />}
              label="Tools"
              active={isActive("/tools")}
              collapsed={collapsed}
            />
          </>
        )}

        <NavItem
          to="/jobs"
          icon={<CalendarClock className="h-4 w-4" />}
          label="Jobs"
          active={isActive("/jobs")}
          collapsed={collapsed}
        />
        <NavItem
          to="/models"
          icon={<Cpu className="h-4 w-4" />}
          label="Models"
          active={isActive("/models")}
          collapsed={collapsed}
        />
      </nav>

      {/* Version + User footer */}
      {!collapsed && (
        <p className="px-4 pb-1 text-[10px] text-muted-foreground/50 select-none">
          v{__APP_VERSION__}
        </p>
      )}
      {user && (
        <div
          className={cn(
            "flex items-center gap-3 border-t px-4 py-3",
            collapsed ? "justify-center px-2" : "",
          )}
        >
          {user.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt={user.displayName ?? user.email}
              className="h-8 w-8 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              {initials}
            </div>
          )}
          {!collapsed && (
            <div className="min-w-0 flex-1">
              {user.displayName && (
                <p className="truncate text-sm font-medium text-sidebar-foreground">
                  {user.displayName}
                </p>
              )}
              <p className="truncate text-xs text-muted-foreground">
                {user.email}
              </p>
            </div>
          )}
          {provider === "password" && !collapsed && (
            <button
              onClick={logout}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </>
  );
}
