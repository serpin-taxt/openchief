import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth";
import { RequireAuth } from "@/components/RequireAuth";
import { RequireRole } from "@/components/RequireRole";
import { Layout } from "@/components/Layout";
import { Login } from "@/pages/Login";
import { Home } from "@/pages/Home";
import { Agents } from "@/pages/Agents";
import { AgentDetail } from "@/pages/AgentDetail";
import { AgentHistory } from "@/pages/AgentHistory";
import { ReportView } from "@/pages/ReportView";
import { Connections } from "@/pages/Connections";
import { ConnectionDetail } from "@/pages/ConnectionDetail";
import { Tools } from "@/pages/Tools";
import { PersonaGenerator } from "@/pages/PersonaGenerator";
import { Team } from "@/pages/Team";
import { Jobs } from "@/pages/Jobs";
import { Models } from "@/pages/Models";
import { Tasks } from "@/pages/Tasks";
import { TaskDetail } from "@/pages/TaskDetail";

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
            <Route path="/agents/:id" element={<AgentDetail />} />
            <Route path="/agents/:id/history" element={<AgentHistory />} />
            <Route
              path="/agents/:id/reports/:reportId"
              element={<ReportView />}
            />
            {/* Legacy /modules routes → redirect to /agents */}
            <Route
              path="/modules"
              element={<Navigate to="/agents" replace />}
            />
            <Route
              path="/modules/:id/*"
              element={<Navigate to="/agents" replace />}
            />
            {/* Superadmin only */}
            <Route element={<RequireRole minRole="superadmin" />}>
              <Route path="/connections" element={<Connections />} />
              <Route
                path="/connections/:source"
                element={<ConnectionDetail />}
              />
              <Route path="/tools" element={<Tools />} />
              <Route
                path="/tools/persona-generator"
                element={<PersonaGenerator />}
              />
            </Route>
            <Route path="/team" element={<Team />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/tasks/:id" element={<TaskDetail />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/models" element={<Models />} />
          </Route>
        </Route>
      </Routes>
    </AuthProvider>
  );
}
