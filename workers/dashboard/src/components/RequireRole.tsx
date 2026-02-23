import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/lib/auth";

/**
 * Route guard that restricts access based on user role.
 *
 * - "superadmin" — only superadmin can access
 * - "exec" — superadmin or exec can access
 *
 * If the user doesn't meet the minimum role, they are redirected to /.
 */
export function RequireRole({ minRole }: { minRole: "superadmin" | "exec" }) {
  const { role } = useAuth();

  if (minRole === "superadmin" && role !== "superadmin") {
    return <Navigate to="/" replace />;
  }

  if (minRole === "exec" && role !== "superadmin" && role !== "exec") {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
