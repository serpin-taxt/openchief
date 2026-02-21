import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth";
import { RequireAuth } from "@/components/RequireAuth";
import { Layout } from "@/components/Layout";
import { Login } from "@/pages/Login";
import { Home } from "@/pages/Home";
import { Agents } from "@/pages/Agents";
import { AgentDetail } from "@/pages/AgentDetail";
import { AgentHistory } from "@/pages/AgentHistory";
import { ReportView } from "@/pages/ReportView";
import { Connections } from "@/pages/Connections";
import { ConnectionDetail } from "@/pages/ConnectionDetail";
import { Team } from "@/pages/Team";
import { Jobs } from "@/pages/Jobs";
import { Models } from "@/pages/Models";

export function App() {
  return (
    <AuthProvider>
      <Toaster theme="dark" position="bottom-right" richColors />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth />}>
          <Route element={<Layout />}>
            <Route path="/" element={<Home />} />
            <Route path="/agents" element={<Agents />} />
            <Route
              path="/modules"
              element={<Navigate to="/agents" replace />}
            />
            <Route path="/modules/:id" element={<AgentDetail />} />
            <Route path="/modules/:id/history" element={<AgentHistory />} />
            <Route
              path="/modules/:id/reports/:reportId"
              element={<ReportView />}
            />
            <Route path="/connections" element={<Connections />} />
            <Route
              path="/connections/:source"
              element={<ConnectionDetail />}
            />
            <Route path="/team" element={<Team />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/models" element={<Models />} />
          </Route>
        </Route>
      </Routes>
    </AuthProvider>
  );
}
