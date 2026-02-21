/**
 * Rippling REST API client.
 * Handles authentication, pagination, and typed responses.
 * API docs: https://developer.rippling.com/documentation/rest-api
 */

// --- Types ---

export interface RipplingWorker {
  id: string;
  personalEmail?: string;
  workEmail?: string;
  firstName: string;
  lastName: string;
  displayName?: string;
  jobTitle?: string;
  department?: RipplingDepartment | null;
  manager?: RipplingWorkerRef | null;
  employmentType?: string; // EMPLOYEE, CONTRACTOR, etc.
  startDate?: string;
  endDate?: string | null;
  status?: string; // ACTIVE, TERMINATED, ON_LEAVE
  workLocation?: string | null;
}

export interface RipplingWorkerRef {
  id: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
}

export interface RipplingDepartment {
  id: string;
  name: string;
  parentDepartment?: { id: string; name: string } | null;
}

export interface RipplingLeaveRequest {
  id: string;
  worker?: RipplingWorkerRef;
  leaveType?: string;
  status: string; // APPROVED, PENDING, DENIED, CANCELLED
  startDate: string;
  endDate: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RipplingLeaveBalance {
  id: string;
  worker?: RipplingWorkerRef;
  leaveType?: string;
  balanceInDays?: number;
  balanceInMinutes?: number;
}

export interface RipplingPayRun {
  id: string;
  runDate?: string;
  payPeriodStartDate?: string;
  payPeriodEndDate?: string;
  status?: string; // DRAFT, PROCESSING, COMPLETED, FAILED
  workerCount?: number;
}

interface PaginatedResponse<T> {
  data: T[];
  next?: string | null;
  hasMore?: boolean;
}

// --- Client ---

const BASE_URL = "https://rest.ripplingapis.com";
const MAX_RETRIES = 3;
const MAX_PAGES = 50; // Safety limit to prevent infinite pagination

export class RipplingClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  // --- Workers / Employees ---

  async listWorkers(): Promise<RipplingWorker[]> {
    return this.paginateAll<RipplingWorker>(
      "/workers",
      { expand: "manager,department,employment_type" }
    );
  }

  // --- Departments ---

  async listDepartments(): Promise<RipplingDepartment[]> {
    return this.paginateAll<RipplingDepartment>("/departments");
  }

  // --- Leave / Time Off ---

  async listLeaveRequests(since?: string): Promise<RipplingLeaveRequest[]> {
    const params: Record<string, string> = {};
    if (since) {
      params["filter[updated_at][gte]"] = since;
    }
    params["filter[status]"] = "APPROVED";
    return this.paginateAll<RipplingLeaveRequest>("/leave_requests", params);
  }

  async listLeaveBalances(): Promise<RipplingLeaveBalance[]> {
    return this.paginateAll<RipplingLeaveBalance>("/leave_balances");
  }

  // --- Payroll ---

  async listPayRuns(since?: string): Promise<RipplingPayRun[]> {
    const params: Record<string, string> = {};
    if (since) {
      params["filter[updated_at][gte]"] = since;
    }
    return this.paginateAll<RipplingPayRun>("/pay_runs", params);
  }

  // --- HTTP Layer ---

  private async paginateAll<T>(
    path: string,
    params?: Record<string, string>
  ): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | null = null;
    let page = 0;

    do {
      const queryParams = new URLSearchParams(params || {});
      queryParams.set("limit", "100");
      if (cursor) {
        queryParams.set("cursor", cursor);
      }

      const url = `${BASE_URL}${path}?${queryParams.toString()}`;
      const response = await this.fetchWithRetry(url);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Rippling API error ${response.status} on ${path}: ${text}`);
      }

      const body = await response.json() as PaginatedResponse<T>;
      all.push(...(body.data || []));

      cursor = body.next || null;
      page++;
    } while (cursor && page < MAX_PAGES);

    return all;
  }

  private async fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "User-Agent": "openchief-connector-rippling",
        },
      });

      // Rate limited -- wait and retry
      if (response.status === 429 && attempt < retries) {
        const retryAfter = response.headers.get("retry-after");
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : (attempt + 1) * 2000;
        console.log(`Rippling rate limited, waiting ${waitMs}ms before retry ${attempt + 1}`);
        await sleep(waitMs);
        continue;
      }

      // Server error -- retry with backoff
      if (response.status >= 500 && attempt < retries) {
        const waitMs = (attempt + 1) * 3000;
        console.log(`Rippling server error ${response.status}, retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      return response;
    }

    // Should never reach here, but TypeScript needs it
    throw new Error(`Rippling API failed after ${retries} retries`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
