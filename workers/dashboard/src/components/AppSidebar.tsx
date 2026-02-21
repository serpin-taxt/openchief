import { Link, useLocation } from "react-router-dom";
import {
  Bot,
  Home,
  Users,
  CalendarClock,
  Cpu,
  Cable,
  LogOut,
  type LucideProps,
} from "lucide-react";
import type { CurrentUser } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import type { ComponentType } from "react";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface NavItemProps {
  href: string;
  icon: ComponentType<LucideProps>;
  label: string;
  collapsed: boolean;
  isActive: boolean;
  trailing?: React.ReactNode;
}

function NavItem({
  href,
  icon: Icon,
  label,
  collapsed,
  isActive,
  trailing,
}: NavItemProps) {
  return (
    <Link
      to={href}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        collapsed ? "justify-center" : "",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/50",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && (
        <>
          <span className="truncate flex-1">{label}</span>
          {trailing}
        </>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// AppSidebar
// ---------------------------------------------------------------------------

interface AppSidebarProps {
  agents: unknown[];
  connections: unknown[];
  user: CurrentUser | null;
  collapsed: boolean;
}

export function AppSidebar({
  user,
  collapsed,
}: AppSidebarProps) {
  const location = useLocation();
  const { provider, logout } = useAuth();

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
        className={cn(
          "flex h-14 shrink-0 items-center gap-2 border-b px-4",
          collapsed ? "justify-center px-2" : "",
        )}
      >
        <svg className="h-6 w-6 shrink-0 text-sidebar-primary" viewBox="6 12 52 42" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M10 44C10 44 18 50 32 50C46 50 54 44 54 44" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          <path d="M10 44L14 22L24 36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M54 44L50 22L40 36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M24 36L32 16L40 36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        {!collapsed && (
          <span className="text-lg font-semibold tracking-tight text-sidebar-foreground">
            OpenChief
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        <NavItem
          href="/"
          icon={Home}
          label="Home"
          collapsed={collapsed}
          isActive={location.pathname === "/"}
        />
        <NavItem
          href="/agents"
          icon={Bot}
          label="Agents"
          collapsed={collapsed}
          isActive={
            location.pathname === "/agents" ||
            location.pathname.startsWith("/modules/")
          }
        />
        <NavItem
          href="/team"
          icon={Users}
          label="Humans"
          collapsed={collapsed}
          isActive={location.pathname.startsWith("/team")}
        />
        <NavItem
          href="/connections"
          icon={Cable}
          label="Connections"
          collapsed={collapsed}
          isActive={location.pathname.startsWith("/connections")}
        />
        <NavItem
          href="/jobs"
          icon={CalendarClock}
          label="Jobs"
          collapsed={collapsed}
          isActive={location.pathname.startsWith("/jobs")}
        />
        <NavItem
          href="/models"
          icon={Cpu}
          label="Models"
          collapsed={collapsed}
          isActive={location.pathname.startsWith("/models")}
        />
      </nav>

      {/* User footer */}
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
