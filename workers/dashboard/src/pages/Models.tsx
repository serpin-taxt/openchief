import { useEffect, useState, useCallback } from "react";
import { Save, Loader2, Cpu } from "lucide-react";
import { api, type ModelSetting } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

const MODEL_OPTIONS = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

const JOB_TYPE_LABELS: Record<string, string> = {
  "daily-report": "Daily Report",
  "weekly-report": "Weekly Report",
  chat: "Chat",
};

interface EditState {
  modelId: string;
  maxTokens: number;
}

export function Models() {
  const [settings, setSettings] = useState<ModelSetting[]>([]);
  const [edits, setEdits] = useState<Record<string, EditState>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const loadSettings = useCallback(async () => {
    try {
      const data = await api.get<ModelSetting[]>("models");
      setSettings(data);
    } catch (err) {
      console.error("Failed to load model settings:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  function getEditState(setting: ModelSetting): EditState {
    return (
      edits[setting.jobType] ?? {
        modelId: setting.modelId,
        maxTokens: setting.maxTokens,
      }
    );
  }

  function updateEdit(jobType: string, partial: Partial<EditState>) {
    setEdits((prev) => {
      const current = prev[jobType] ?? {
        modelId:
          settings.find((s) => s.jobType === jobType)?.modelId ?? "claude-sonnet-4-6",
        maxTokens:
          settings.find((s) => s.jobType === jobType)?.maxTokens ?? 4096,
      };
      return { ...prev, [jobType]: { ...current, ...partial } };
    });
  }

  function hasChanges(setting: ModelSetting): boolean {
    const edit = edits[setting.jobType];
    if (!edit) return false;
    return (
      edit.modelId !== setting.modelId ||
      edit.maxTokens !== setting.maxTokens
    );
  }

  async function handleSave(jobType: string) {
    const edit = edits[jobType];
    if (!edit) return;

    setSaving((prev) => new Set(prev).add(jobType));
    try {
      await api.put(`models/${jobType}`, {
        modelId: edit.modelId,
        maxTokens: edit.maxTokens,
      });
      // Clear edit state and reload
      setEdits((prev) => {
        const next = { ...prev };
        delete next[jobType];
        return next;
      });
      await loadSettings();
    } catch (err) {
      console.error("Failed to save model setting:", err);
    } finally {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(jobType);
        return next;
      });
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // If no settings exist yet, show defaults for common job types
  const jobTypes =
    settings.length > 0
      ? settings
      : [
          {
            jobType: "daily-report",
            modelId: "claude-sonnet-4-6",
            maxTokens: 4096,
            updatedAt: "",
            updatedBy: null,
          },
          {
            jobType: "weekly-report",
            modelId: "claude-sonnet-4-6",
            maxTokens: 8192,
            updatedAt: "",
            updatedBy: null,
          },
          {
            jobType: "chat",
            modelId: "claude-sonnet-4-6",
            maxTokens: 4096,
            updatedAt: "",
            updatedBy: null,
          },
        ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Models</h1>
        <p className="text-sm text-muted-foreground">
          Configure AI models for each job type
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {jobTypes.map((setting) => {
          const edit = getEditState(setting);
          const changed = hasChanges(setting);
          const isSaving = saving.has(setting.jobType);

          return (
            <Card key={setting.jobType}>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-base">
                    {JOB_TYPE_LABELS[setting.jobType] ?? setting.jobType}
                  </CardTitle>
                </div>
                {setting.updatedAt && (
                  <CardDescription>
                    Last updated {formatDateTime(setting.updatedAt)}
                    {setting.updatedBy && ` by ${setting.updatedBy}`}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Model Selector */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Model</label>
                  <Select
                    value={edit.modelId}
                    onChange={(e) =>
                      updateEdit(setting.jobType, {
                        modelId: e.target.value,
                      })
                    }
                  >
                    {MODEL_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                </div>

                {/* Max Tokens */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Max Tokens</label>
                  <Input
                    type="number"
                    min={256}
                    max={32768}
                    step={256}
                    value={edit.maxTokens}
                    onChange={(e) =>
                      updateEdit(setting.jobType, {
                        maxTokens: parseInt(e.target.value, 10) || 4096,
                      })
                    }
                  />
                </div>

                {/* Save */}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={!changed || isSaving}
                    onClick={() => handleSave(setting.jobType)}
                  >
                    {isSaving ? (
                      <>
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="mr-1.5 h-3.5 w-3.5" />
                        Save
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
