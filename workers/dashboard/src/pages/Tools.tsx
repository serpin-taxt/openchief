import { Link } from "react-router-dom";
import { Sparkles, ChevronRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

const TOOLS = [
  {
    id: "persona-generator",
    name: "Persona Generator",
    description:
      "Analyze a person's Slack messages to generate voice, personality, and output style fields for agent personas.",
    icon: Sparkles,
    path: "/tools/persona-generator",
  },
];

export function Tools() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tools</h1>
        <p className="mt-1 text-muted-foreground">
          Superadmin utilities for configuring OpenChief
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map((tool) => (
          <Link key={tool.id} to={tool.path}>
            <Card className="group cursor-pointer transition-colors hover:border-ring">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <tool.icon className="h-5 w-5 text-muted-foreground" />
                  <CardTitle className="text-base">{tool.name}</CardTitle>
                  <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
                </div>
              </CardHeader>
              <CardContent>
                <CardDescription>{tool.description}</CardDescription>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
