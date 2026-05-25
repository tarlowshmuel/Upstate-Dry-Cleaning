import { useEffect, useState } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Legal from "@/pages/legal";
import Login from "@/pages/login";

const queryClient = new QueryClient();

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_BASE = `${BASE}/api`;

function AdminGate() {
  const [status, setStatus] = useState<"checking" | "authed" | "anon">("checking");

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/admin/me`, { credentials: "include" })
      .then((r) => r.json())
      .then((data: { authed?: boolean }) => {
        if (cancelled) return;
        setStatus(data.authed ? "authed" : "anon");
      })
      .catch(() => {
        if (!cancelled) setStatus("anon");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "checking") {
    return <div className="min-h-screen flex items-center justify-center text-slate-500">Loading…</div>;
  }
  if (status === "anon") {
    return <Login apiBase={API_BASE} onSuccess={() => setStatus("authed")} />;
  }
  return <Dashboard />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={AdminGate} />
      <Route path="/legal" component={Legal} />
      <Route path="/privacy" component={Legal} />
      <Route path="/terms" component={Legal} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={BASE}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
