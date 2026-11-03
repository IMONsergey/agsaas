"use client";

import { cn } from "@midday/ui/cn";
import { Icons } from "@midday/ui/icons";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const icons = {
  "/": () => <Icons.Overview size={20} />,
  "/reports": () => <Icons.Monitoring size={20} />,
  "/transactions": () => <Icons.Transactions size={20} />,
  "/invoices": () => <Icons.Invoice size={20} />,
  "/tracker": () => <Icons.Tracker size={20} />,
  "/customers": () => <Icons.Customers size={20} />,
  "/vault": () => <Icons.Vault size={20} />,
  "/settings": () => <Icons.Settings size={20} />,
  "/apps": () => <Icons.Apps size={20} />,
  "/inbox": () => <Icons.Inbox2 size={20} />,
} as const;

const items = [
  {
    path: "/",
    name: "Overview",
  },
  {
    path: "/reports",
    name: "Reports",
  },
  {
    path: "/transactions",
    name: "Transactions",
    children: [
      {
        path: "/transactions/categories",
        name: "Categories",
      },
      {
        path: "/transactions?step=connect",
        name: "Connect bank",
      },
      {
        path: "/transactions?step=import&hide=true",
        name: "Import",
      },
      { path: "/transactions?createTransaction=true", name: "Create new" },
    ],
  },
  {
    path: "/inbox",
    name: "Inbox",
    children: [{ path: "/inbox/settings", name: "Settings" }],
  },
  {
    path: "/invoices",
    name: "Invoices",
    children: [
      { path: "/invoices/products", name: "Products" },
      { path: "/invoices?invoiceType=create", name: "Create new" },
    ],
  },
  {
    path: "/tracker",
    name: "Tracker",
    children: [{ path: "/tracker?create=true", name: "Create new" }],
  },
  {
    path: "/customers",
    name: "Customers",
    children: [{ path: "/customers?createCustomer=true", name: "Create new" }],
  },
  {
    path: "/vault",
    name: "Vault",
  },
  {
    path: "/apps",
    name: "Apps",
    children: [
      { path: "/apps", name: "All" },
      { path: "/apps?tab=installed", name: "Installed" },
    ],
  },
  {
    path: "/settings",
    name: "Settings",
    children: [
      { path: "/settings", name: "General" },
      { path: "/settings/billing", name: "Billing" },
      { path: "/settings/accounts", name: "Bank Connections" },
      { path: "/settings/members", name: "Members" },
      { path: "/settings/notifications", name: "Notifications" },
      { path: "/settings/developer", name: "Developer" },
    ],
  },
];

interface ItemProps {
  item: {
    path: string;
    name: string;
    children?: { path: string; name: string }[];
  };
  isActive: boolean;
  isExpanded: boolean;
  isItemExpanded: boolean;
  onToggle: (path: string) => void;
  onSelect?: () => void;
}

const ChildItem = ({
  child,
  isActive,
  isExpanded,
  shouldShow,
  onSelect,
  index,
}: {
  child: { path: string; name: string };
  isActive: boolean;
  isExpanded: boolean;
  shouldShow: boolean;
  onSelect?: () => void;
  index: number;
}) => {
  const showChild = isExpanded && shouldShow;

  return (
    <Link
      href={child.path}
      tabIndex={showChild ? 0 : -1}
      aria-hidden={!showChild}
      aria-current={isActive ? "page" : undefined}
      prefetch
      onClick={() => onSelect?.()}
      className="block group/child"
    >
      <div className="relative">
        {/* Child item text */}
        <div
          className={cn(
            "ml-[35px] mr-[15px] h-[32px] flex items-center",
            "border-l border-[#e6e6e6] dark:border-[#1d1d1d] pl-3",
            "transition-all duration-200 ease-out",
            showChild
              ? "opacity-100 translate-x-0"
              : "opacity-0 -translate-x-2",
          )}
          style={{
            transitionDelay: showChild
              ? `${40 + index * 20}ms`
              : `${index * 20}ms`,
          }}
        >
          <span
            className={cn(
              "text-xs font-medium transition-colors duration-200",
              "text-[#888] group-hover/child:text-primary",
              "whitespace-nowrap overflow-hidden",
              isActive && "text-primary",
            )}
          >
            {child.name}
          </span>
        </div>
      </div>
    </Link>
  );
};

const Item = ({
  item,
  isActive,
  isExpanded,
  isItemExpanded,
  onToggle,
  onSelect,
}: ItemProps) => {
  const Icon = icons[item.path as keyof typeof icons];
  const pathname = usePathname();
  const hasChildren = !!item.children?.length;
  const shouldShowChildren = isExpanded && isItemExpanded;
  return (
    <div className="group">
      <div
        className={cn(
          "relative mx-[15px] flex min-h-10 items-center border border-transparent",
          isActive && "bg-accent border-border",
        )}
      >
        <Link
          href={item.path}
          prefetch
          aria-label={item.name}
          aria-current={isActive ? "page" : undefined}
          onClick={() => onSelect?.()}
          className="flex min-w-0 flex-1 items-center min-h-10 focus-visible:outline focus-visible:outline-2"
        >
          <span className="flex w-10 shrink-0 justify-center">
            <Icon />
          </span>
          <span
            className={isExpanded ? "truncate text-sm font-medium" : "sr-only"}
          >
            {item.name}
          </span>
        </Link>
        {hasChildren && isExpanded && (
          <button
            type="button"
            aria-label={`${shouldShowChildren ? "Collapse" : "Expand"} ${item.name}`}
            aria-expanded={shouldShowChildren}
            onClick={() => onToggle(item.path)}
            className="flex size-9 shrink-0 items-center justify-center hover:bg-secondary focus-visible:outline focus-visible:outline-2"
          >
            <Icons.ChevronDown
              size={16}
              className={shouldShowChildren ? "rotate-180" : undefined}
            />
          </button>
        )}
      </div>
      {shouldShowChildren && (
        <div className="mt-1">
          {item.children!.map((child, index) => (
            <ChildItem
              key={child.path}
              child={child}
              isActive={pathname === child.path.split("?")[0]}
              isExpanded={isExpanded}
              shouldShow={shouldShowChildren}
              onSelect={onSelect}
              index={index}
            />
          ))}
        </div>
      )}
    </div>
  );
};

type Props = {
  onSelect?: () => void;
  isExpanded?: boolean;
};

export function MainMenu({ onSelect, isExpanded = false }: Props) {
  const pathname = usePathname();
  const part = pathname?.split("/")[1];
  const [expandedItem, setExpandedItem] = useState<string | null>(null);

  // Reset expanded item when sidebar expands/collapses
  useEffect(() => {
    setExpandedItem(null);
  }, [isExpanded]);

  return (
    <div className="mt-4 w-full">
      <nav className="w-full" aria-label="Workspace navigation">
        <div className="flex flex-col gap-2">
          {items.map((item) => {
            const isActive =
              (pathname === "/" && item.path === "/") ||
              (pathname !== "/" && item.path.startsWith(`/${part}`));

            return (
              <Item
                key={item.path}
                item={item}
                isActive={isActive}
                isExpanded={isExpanded}
                isItemExpanded={expandedItem === item.path}
                onToggle={(path) => {
                  setExpandedItem(expandedItem === path ? null : path);
                }}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      </nav>
    </div>
  );
}
