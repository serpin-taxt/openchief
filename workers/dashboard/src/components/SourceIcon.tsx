import {
  GitBranch,
  MessageSquare,
  Gamepad2,
  Pen,
  BarChart3,
  Twitter,
  TrendingDown,
  Calendar,
  MessagesSquare,
  FileText,
  Target,
  DollarSign,
  Database,
  Users,
  Lightbulb,
  Headphones,
  Link,
  type LucideProps,
} from "lucide-react";
import type { ComponentType } from "react";

const sourceIconMap: Record<string, ComponentType<LucideProps>> = {
  github: GitBranch,
  slack: MessageSquare,
  discord: Gamepad2,
  figma: Pen,
  amplitude: BarChart3,
  twitter: Twitter,
  googleanalytics: TrendingDown,
  googlecalendar: Calendar,
  intercom: MessagesSquare,
  notion: FileText,
  jira: Target,
  quickbooks: DollarSign,
  database: Database,
  rippling: Users,
  jpd: Lightbulb,
  jsm: Headphones,
};

interface SourceIconProps {
  name: string;
  className?: string;
}

export function SourceIcon({ name, className }: SourceIconProps) {
  const Icon = sourceIconMap[name.toLowerCase()] ?? Link;
  return <Icon className={className} />;
}
