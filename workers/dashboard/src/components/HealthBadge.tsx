import { cn } from "@/lib/utils";

const signalConfig = {
  green: {
    label: "Healthy",
    bg: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30",
    dot: "bg-emerald-500",
  },
  yellow: {
    label: "Warning",
    bg: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
    dot: "bg-amber-500",
  },
  red: {
    label: "Critical",
    bg: "bg-red-500/15 text-red-400 border border-red-500/30",
    dot: "bg-red-500",
  },
};

export function HealthBadge({
  signal,
  className,
}: {
  signal: "green" | "yellow" | "red" | string | null;
  className?: string;
}) {
  const config =
    signalConfig[signal as keyof typeof signalConfig] ?? signalConfig.green;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        config.bg,
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", config.dot)} />
      {config.label}
    </span>
  );
}
