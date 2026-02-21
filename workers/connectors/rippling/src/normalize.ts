/**
 * Normalize Rippling HRIS data into OpenChiefEvent format.
 *
 * CRITICAL: All compensation/salary data is stripped via redactCompensation()
 * before any event is created. No dollar amounts ever leave this connector.
 */

import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";
import type {
  RipplingWorker,
  RipplingDepartment,
  RipplingLeaveRequest,
  RipplingLeaveBalance,
  RipplingPayRun,
} from "./rippling-client";

// --- Compensation Redaction ---

/**
 * SECURITY: Strip ALL compensation/salary/pay fields from payloads.
 * This runs on every event before it enters the queue.
 * Defense in depth -- even if the API returns unexpected fields.
 */
const REDACTED_FIELD_PATTERNS = [
  "salary",
  "compensation",
  "pay",
  "wage",
  "rate",
  "amount",
  "gross",
  "net",
  "bonus",
  "equity",
  "stock",
  "options",
  "base_pay",
  "total_pay",
  "annual",
  "hourly",
  "income",
  "earnings",
  "deduction",
  "withholding",
  "tax_amount",
  "stipend",
  "commission",
  "overtime_pay",
];

export function redactCompensation(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const lowerKey = key.toLowerCase();
    // Skip any field whose name matches a compensation pattern
    if (REDACTED_FIELD_PATTERNS.some((p) => lowerKey.includes(p))) {
      continue;
    }
    // Recursively redact nested objects
    if (value && typeof value === "object" && !Array.isArray(value)) {
      clean[key] = redactCompensation(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

// --- Worker Snapshot Types ---

export interface WorkerSnapshot {
  id: string;
  name: string;
  email: string;
  title: string;
  department: string;
  manager: string;
  status: string;
  employmentType: string;
  startDate: string;
  endDate: string | null;
}

export function workerToSnapshot(w: RipplingWorker): WorkerSnapshot {
  return {
    id: w.id,
    name: `${w.firstName} ${w.lastName}`.trim(),
    email: w.workEmail || w.personalEmail || "",
    title: w.jobTitle || "Unknown",
    department: w.department?.name || "Unknown",
    manager: w.manager
      ? `${w.manager.firstName || ""} ${w.manager.lastName || ""}`.trim()
      : "None",
    status: w.status || "ACTIVE",
    employmentType: w.employmentType || "EMPLOYEE",
    startDate: w.startDate || "",
    endDate: w.endDate || null,
  };
}

// --- Employee Change Events ---

export function diffWorkerSnapshots(
  previous: Record<string, WorkerSnapshot>,
  current: Record<string, WorkerSnapshot>,
  now: string
): OpenChiefEvent[] {
  const events: OpenChiefEvent[] = [];

  // Check for new hires and changes
  for (const [id, curr] of Object.entries(current)) {
    const prev = previous[id];

    if (!prev) {
      // New employee
      events.push(makeEvent("employee.hired", now, curr, {
        name: curr.name,
        email: curr.email,
        title: curr.title,
        department: curr.department,
        manager: curr.manager,
        start_date: curr.startDate,
        employment_type: curr.employmentType,
      }, `${curr.name} joined as ${curr.title} in ${curr.department}`));
      continue;
    }

    // Status change (active -> terminated, on_leave, etc.)
    if (prev.status !== curr.status) {
      if (curr.status === "TERMINATED" || curr.endDate) {
        const tenureMonths = curr.startDate
          ? Math.round(
              (new Date(now).getTime() - new Date(curr.startDate).getTime()) /
                (1000 * 60 * 60 * 24 * 30)
            )
          : null;
        events.push(makeEvent("employee.departed", now, curr, {
          name: curr.name,
          title: curr.title,
          department: curr.department,
          end_date: curr.endDate || now.split("T")[0],
          tenure_months: tenureMonths,
        }, `${curr.name} (${curr.title}, ${curr.department}) departing${curr.endDate ? ` on ${curr.endDate}` : ""}`));
      } else {
        events.push(makeEvent("employee.status_changed", now, curr, {
          name: curr.name,
          old_status: prev.status,
          new_status: curr.status,
          department: curr.department,
        }, `${curr.name}'s status changed from ${prev.status} to ${curr.status}`));
      }
    }

    // Title change
    if (prev.title !== curr.title) {
      events.push(makeEvent("employee.title_changed", now, curr, {
        name: curr.name,
        old_title: prev.title,
        new_title: curr.title,
        department: curr.department,
      }, `${curr.name} title changed from ${prev.title} to ${curr.title}`));
    }

    // Department change
    if (prev.department !== curr.department) {
      events.push(makeEvent("employee.department_changed", now, curr, {
        name: curr.name,
        old_department: prev.department,
        new_department: curr.department,
        old_manager: prev.manager,
        new_manager: curr.manager,
      }, `${curr.name} moved from ${prev.department} to ${curr.department}`));
    }

    // Manager change (only if department didn't also change -- avoid duplicate noise)
    if (prev.manager !== curr.manager && prev.department === curr.department) {
      events.push(makeEvent("employee.manager_changed", now, curr, {
        name: curr.name,
        old_manager: prev.manager,
        new_manager: curr.manager,
        department: curr.department,
      }, `${curr.name}'s manager changed from ${prev.manager} to ${curr.manager}`));
    }
  }

  // Check for departures (in previous but not in current)
  for (const [id, prev] of Object.entries(previous)) {
    if (!current[id]) {
      events.push(makeEvent("employee.departed", now, prev, {
        name: prev.name,
        title: prev.title,
        department: prev.department,
        end_date: now.split("T")[0],
      }, `${prev.name} (${prev.title}, ${prev.department}) no longer in roster`));
    }
  }

  return events;
}

// --- Department Change Events ---

export function diffDepartments(
  previous: Record<string, string>, // id -> name
  current: Record<string, string>,
  now: string
): OpenChiefEvent[] {
  const events: OpenChiefEvent[] = [];

  for (const [id, name] of Object.entries(current)) {
    if (!previous[id]) {
      events.push({
        id: generateULID(),
        timestamp: now,
        ingestedAt: now,
        source: "rippling",
        eventType: "org.department_created",
        scope: { project: name },
        payload: redactCompensation({ department_id: id, department_name: name }),
        summary: `New department created: ${name}`,
      });
    } else if (previous[id] !== name) {
      events.push({
        id: generateULID(),
        timestamp: now,
        ingestedAt: now,
        source: "rippling",
        eventType: "org.department_updated",
        scope: { project: name },
        payload: redactCompensation({
          department_id: id,
          old_name: previous[id],
          new_name: name,
        }),
        summary: `Department renamed from "${previous[id]}" to "${name}"`,
      });
    }
  }

  return events;
}

// --- Time Off Events ---

export function normalizeLeaveRequests(
  requests: RipplingLeaveRequest[],
  now: string
): OpenChiefEvent[] {
  return requests.map((req) => {
    const workerName = req.worker
      ? `${req.worker.firstName || ""} ${req.worker.lastName || ""}`.trim()
      : "Unknown";

    const startDate = req.startDate;
    const endDate = req.endDate;
    const days = startDate && endDate
      ? Math.ceil(
          (new Date(endDate).getTime() - new Date(startDate).getTime()) /
            (1000 * 60 * 60 * 24)
        ) + 1
      : null;

    return {
      id: generateULID(),
      timestamp: req.updatedAt || req.createdAt || now,
      ingestedAt: now,
      source: "rippling",
      eventType: "timeoff.approved",
      scope: {
        actor: workerName,
      },
      payload: redactCompensation({
        request_id: req.id,
        employee_name: workerName,
        leave_type: req.leaveType || "PTO",
        start_date: startDate,
        end_date: endDate,
        days,
        status: req.status,
      }),
      summary: `${workerName} approved for ${req.leaveType || "time off"}: ${startDate} to ${endDate}${days ? ` (${days} days)` : ""}`,
    } satisfies OpenChiefEvent;
  });
}

export function normalizeLeaveBalanceLowAlerts(
  balances: RipplingLeaveBalance[],
  thresholdDays: number,
  now: string
): OpenChiefEvent[] {
  const events: OpenChiefEvent[] = [];

  for (const bal of balances) {
    const days = bal.balanceInDays ?? (bal.balanceInMinutes != null ? bal.balanceInMinutes / 480 : null);
    if (days == null || days >= thresholdDays) continue;

    const workerName = bal.worker
      ? `${bal.worker.firstName || ""} ${bal.worker.lastName || ""}`.trim()
      : "Unknown";

    events.push({
      id: generateULID(),
      timestamp: now,
      ingestedAt: now,
      source: "rippling",
      eventType: "timeoff.balance_low",
      scope: { actor: workerName },
      payload: redactCompensation({
        employee_name: workerName,
        leave_type: bal.leaveType || "PTO",
        balance_days: Math.round(days * 10) / 10,
      }),
      summary: `${workerName} has only ${Math.round(days * 10) / 10} days of ${bal.leaveType || "PTO"} remaining`,
    });
  }

  return events;
}

// --- Payroll Events ---

/**
 * Normalize pay run events -- HEADCOUNT AND STATUS ONLY.
 * Dollar amounts are NEVER included.
 */
export function normalizePayRuns(
  runs: RipplingPayRun[],
  now: string
): OpenChiefEvent[] {
  return runs.map((run) => {
    const isCompleted = run.status === "COMPLETED";
    const eventType = isCompleted ? "payroll.run_completed" : "payroll.run_failed";

    return {
      id: generateULID(),
      timestamp: run.runDate || now,
      ingestedAt: now,
      source: "rippling",
      eventType,
      scope: {},
      payload: {
        // Explicitly construct payload -- NO raw run data passed through
        run_id: run.id,
        run_date: run.runDate,
        period_start: run.payPeriodStartDate,
        period_end: run.payPeriodEndDate,
        status: run.status,
        headcount_paid: run.workerCount,
      },
      summary: isCompleted
        ? `Payroll run completed for ${run.runDate || "unknown date"} — ${run.workerCount || "?"} employees paid (period: ${run.payPeriodStartDate} to ${run.payPeriodEndDate})`
        : `Payroll run FAILED for ${run.runDate || "unknown date"} — status: ${run.status}`,
      tags: isCompleted ? undefined : ["alert", "payroll-issue"],
    } satisfies OpenChiefEvent;
  });
}

// --- Helpers ---

function makeEvent(
  eventType: string,
  now: string,
  worker: WorkerSnapshot,
  payloadFields: Record<string, unknown>,
  summary: string
): OpenChiefEvent {
  return {
    id: generateULID(),
    timestamp: now,
    ingestedAt: now,
    source: "rippling",
    eventType,
    scope: {
      project: worker.department,
      actor: worker.name,
    },
    payload: redactCompensation(payloadFields),
    summary,
  };
}
