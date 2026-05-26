import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { LayoutDashboard, DollarSign, Settings, BarChart3, Shirt } from "lucide-react";

const NAV = [
  { href: "/", label: "Orders", icon: LayoutDashboard },
  { href: "/earnings", label: "Earnings", icon: BarChart3 },
  { href: "/price-list", label: "Price List", icon: DollarSign },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/order", label: "Customer page", icon: Shirt },
];

export function SiteNav() {
  const [loc] = useLocation();
  return (
    <nav className="flex flex-wrap gap-1 border-b border-border/40 pb-3 mb-6">
      {NAV.map((item) => {
        const active = loc === item.href;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors",
              active
                ? "bg-foreground/10 text-foreground font-semibold"
                : "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
            )}
          >
            <Icon className="w-4 h-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
