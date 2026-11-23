import { Download } from "lucide-react";

export type WorkspaceTab = "parity" | "animation" | "patches";

interface TopBarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  onDownloadBundle: () => void;
}

const NAV_ITEMS: { id: WorkspaceTab; label: string }[] = [
  { id: "parity", label: "Parity Gate" },
  { id: "animation", label: "Animation & IR" },
  { id: "patches", label: "Phase 6 & Patches" },
];

export function TopBar({
  activeTab,
  onSelectTab,
  onDownloadBundle,
}: TopBarProps) {
  return (
    <header className="border-b border-slate-800 bg-slate-950/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-6 py-4">
        <span className="font-display text-lg font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
          Sketchfab Parity Gate
        </span>

        <nav className="flex items-center gap-6" aria-label="Primary sections">
          {NAV_ITEMS.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`relative py-1 text-sm font-medium transition-colors duration-150 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-400 ${
                  active
                    ? "text-sky-400"
                    : "text-slate-400 hover:text-slate-100"
                }`}
              >
                {item.label}
                {active && (
                  <span className="absolute inset-x-0 -bottom-[17px] h-0.5 bg-sky-400" />
                )}
              </button>
            );
          })}
        </nav>

        <button
          type="button"
          onClick={onDownloadBundle}
          className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors duration-150 hover:bg-sky-400 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Download Bundle
        </button>
      </div>
    </header>
  );
}
