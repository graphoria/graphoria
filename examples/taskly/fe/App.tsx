import { Redirect, Route, Switch } from "wouter";
import { AppProvider, type RouteConfig } from "@graphoria/react";
import { Provider as UrqlProvider } from "urql";

import { Layout } from "./components/Layout";
import { ProtectedRoute } from "./ProtectedRoute";

// Pages
import { LoginPage } from "./pages/login";
import { DashboardPage } from "./pages/dashboard";

import "./index.css";
import { urqlClient } from "./urql";

// ============================================================================
// Route Configuration
// ============================================================================

const routeConfig: RouteConfig = {
  permissions: {
    "/": null,
    "/login": null,
    "/dashboard": ["member", "manager", "admin", "superadmin"],
  },
  defaultRoutes: {
    member: "/dashboard",
    manager: "/dashboard",
    admin: "/dashboard",
    superadmin: "/dashboard",
  },
  fallbackRoute: "/login",
};

// ============================================================================
// App Content
// ============================================================================

const AppContent = () => (
  <Layout>
    <Switch>
      {/* Root → dashboard (ProtectedRoute bounces anon users to /login). */}
      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>

      {/* Public */}
      <Route path="/login" component={LoginPage} />

      {/* Admin routes */}
      <Route path="/dashboard">
        <ProtectedRoute>
          <DashboardPage />
        </ProtectedRoute>
      </Route>

      {/* Fallback */}
      <Route>
        <div className="flex items-center justify-center h-full text-gray-500">
          404: Page not found
        </div>
      </Route>
    </Switch>
  </Layout>
);

export const App = () => (
  <AppProvider
    httpUri="/graphql"
    includeCredentials
    routeConfig={routeConfig}
    onLogout={() => {
      // Drop urql's normalized cache + in-flight subscriptions.
      // No first-class clearStore in urql v4 → recreate client or
      // dispatch a reset event. Cheapest: full reload.
      window.location.assign("/login");
    }}
  >
    <UrqlProvider value={urqlClient}>
      <AppContent />
    </UrqlProvider>
  </AppProvider>
);
