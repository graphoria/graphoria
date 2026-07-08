import { Link, useLocation } from "wouter";
import { useAuth, useCanAccess } from "@graphoria/react";
import { cn } from "cnfast";
import { HomeIcon } from "./icons";
import type { IconProps } from "./icons";

// ============================================================================
// Sidebar Navigation Items
// ============================================================================

interface NavItem {
  href: string;
  label: string;
  icon: React.FC<IconProps>;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    title: "Overview",
    items: [{ href: "/dashboard", label: "Dashboard", icon: HomeIcon }],
  },
];

// ============================================================================
// Sidebar Link Component
// ============================================================================

const SidebarLink = ({ href, label, icon: Icon }: NavItem) => {
  const [location] = useLocation();
  const canAccess = useCanAccess(href);
  const isActive = location === href || location.startsWith(href + "/");

  if (!canAccess) return null;

  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors",
        isActive
          ? "bg-gray-800 text-white"
          : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50",
      )}
    >
      <Icon className="w-4 h-4" />
      {label}
    </Link>
  );
};

// ============================================================================
// Sidebar Component
// ============================================================================

const Sidebar = () => {
  return (
    <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col overflow-y-auto shrink-0">
      <div className="p-4 border-b border-gray-800">
        <Link href="/" className="text-lg font-bold text-white tracking-tight">
          Taskly
        </Link>
      </div>
      <nav className="flex-1 p-3 space-y-5">
        {navSections.map((section) => (
          <div key={section.title}>
            <h3 className="px-3 mb-1 text-xs font-semibold text-gray-500 uppercase tracking-wider">
              {section.title}
            </h3>
            <div className="space-y-0.5">
              {section.items.map((item) => (
                <SidebarLink key={item.href} {...item} />
              ))}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
};

// ============================================================================
// User Header Bar
// ============================================================================

const HeaderBar = () => {
  const { isAuthenticated, user, logout } = useAuth();
  const [, setLocation] = useLocation();

  return (
    <header className="bg-gray-900 border-b border-gray-800 px-6 py-2 flex items-center justify-end gap-3 shrink-0">
      {isAuthenticated ? (
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">
            <span className="text-gray-500">Role:</span>{" "}
            <span className="text-white capitalize">{user?.role}</span>
          </span>
          <button
            onClick={() => {
              logout();
              setLocation("/");
            }}
            className="px-3 py-1.5 text-sm rounded text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          >
            Sign out
          </button>
        </div>
      ) : (
        <Link
          href="/login"
          className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          Sign in
        </Link>
      )}
    </header>
  );
};

// ============================================================================
// Layout Component
// ============================================================================

interface LayoutProps {
  children: React.ReactNode;
}

export const Layout = ({ children }: LayoutProps) => (
  <div className="h-screen bg-gray-950 flex">
    <Sidebar />
    <div className="flex-1 flex flex-col min-w-0">
      <HeaderBar />
      <main className="flex-1 p-6 overflow-y-auto">{children}</main>
    </div>
  </div>
);
