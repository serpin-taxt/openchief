/**
 * Normalize QuickBooks Online entities -> OpenChiefEvent format.
 *
 * Handles: Invoice, Payment, Customer, Bill, P&L Report, Balance Sheet.
 */

import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";

function currency(amount: unknown): string {
  const n = Number(amount);
  if (isNaN(n)) return "$0.00";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// --- Invoice ---

export function normalizeInvoice(
  inv: Record<string, unknown>,
  realmId: string
): OpenChiefEvent {
  const meta = inv.MetaData as
    | { LastUpdatedTime?: string; CreateTime?: string }
    | undefined;
  const timestamp =
    meta?.LastUpdatedTime || meta?.CreateTime || new Date().toISOString();

  const customerRef = inv.CustomerRef as
    | { value?: string; name?: string }
    | undefined;
  const totalAmt = inv.TotalAmt as number | undefined;
  const balance = inv.Balance as number | undefined;
  const docNumber = (inv.DocNumber as string) || "";
  const dueDate = inv.DueDate as string | undefined;
  const txnDate = inv.TxnDate as string | undefined;

  // Determine event type
  let eventType = "invoice.updated";
  if (balance === 0 && totalAmt && totalAmt > 0) {
    eventType = "invoice.paid";
  } else if (
    meta?.CreateTime &&
    meta?.LastUpdatedTime &&
    meta.CreateTime === meta.LastUpdatedTime
  ) {
    eventType = "invoice.created";
  }

  // Build summary
  const parts: string[] = [];
  if (eventType === "invoice.paid") {
    parts.push(`Invoice #${docNumber} paid in full`);
  } else if (eventType === "invoice.created") {
    parts.push(`New invoice #${docNumber} created`);
  } else {
    parts.push(`Invoice #${docNumber} updated`);
  }
  if (customerRef?.name) parts.push(`for ${customerRef.name}`);
  if (totalAmt != null) parts.push(`— ${currency(totalAmt)}`);
  if (balance != null && balance > 0) parts.push(`(${currency(balance)} outstanding)`);
  if (dueDate) parts.push(`due ${dueDate}`);

  const tags: string[] = ["invoice"];
  if (eventType === "invoice.paid") tags.push("payment-received");
  if (balance != null && balance > 0 && dueDate) {
    const due = new Date(dueDate);
    if (due < new Date()) tags.push("overdue");
  }

  return {
    id: generateULID(),
    timestamp,
    ingestedAt: new Date().toISOString(),
    source: "quickbooks",
    eventType,
    scope: {
      org: realmId,
      project: "QuickBooks",
      actor: customerRef?.name || undefined,
    },
    payload: {
      qb_id: inv.Id,
      doc_number: docNumber,
      customer: customerRef?.name || null,
      customer_id: customerRef?.value || null,
      total: totalAmt,
      balance,
      due_date: dueDate,
      txn_date: txnDate,
      currency: (inv.CurrencyRef as { value?: string })?.value || "USD",
      line_count: Array.isArray(inv.Line) ? inv.Line.length : 0,
    },
    summary: parts.join(" "),
    tags,
  };
}

// --- Payment ---

export function normalizePayment(
  pmt: Record<string, unknown>,
  realmId: string
): OpenChiefEvent {
  const meta = pmt.MetaData as
    | { LastUpdatedTime?: string; CreateTime?: string }
    | undefined;
  const timestamp =
    meta?.LastUpdatedTime || meta?.CreateTime || new Date().toISOString();

  const customerRef = pmt.CustomerRef as
    | { value?: string; name?: string }
    | undefined;
  const totalAmt = pmt.TotalAmt as number | undefined;
  const txnDate = pmt.TxnDate as string | undefined;
  const paymentMethodRef = pmt.PaymentMethodRef as
    | { value?: string; name?: string }
    | undefined;

  const parts: string[] = [];
  parts.push(`Payment received`);
  if (totalAmt != null) parts.push(`of ${currency(totalAmt)}`);
  if (customerRef?.name) parts.push(`from ${customerRef.name}`);
  if (paymentMethodRef?.name) parts.push(`via ${paymentMethodRef.name}`);
  if (txnDate) parts.push(`on ${txnDate}`);

  return {
    id: generateULID(),
    timestamp,
    ingestedAt: new Date().toISOString(),
    source: "quickbooks",
    eventType: "payment.received",
    scope: {
      org: realmId,
      project: "QuickBooks",
      actor: customerRef?.name || undefined,
    },
    payload: {
      qb_id: pmt.Id,
      customer: customerRef?.name || null,
      customer_id: customerRef?.value || null,
      total: totalAmt,
      txn_date: txnDate,
      payment_method: paymentMethodRef?.name || null,
      currency: (pmt.CurrencyRef as { value?: string })?.value || "USD",
    },
    summary: parts.join(" "),
    tags: ["payment"],
  };
}

// --- Customer ---

export function normalizeCustomer(
  cust: Record<string, unknown>,
  realmId: string
): OpenChiefEvent {
  const meta = cust.MetaData as
    | { LastUpdatedTime?: string; CreateTime?: string }
    | undefined;
  const timestamp =
    meta?.LastUpdatedTime || meta?.CreateTime || new Date().toISOString();

  const displayName = (cust.DisplayName as string) || "Unknown";
  const companyName = cust.CompanyName as string | undefined;
  const balance = cust.Balance as number | undefined;
  const active = cust.Active as boolean | undefined;

  const isNew =
    meta?.CreateTime &&
    meta?.LastUpdatedTime &&
    meta.CreateTime === meta.LastUpdatedTime;

  const parts: string[] = [];
  if (isNew) {
    parts.push(`New customer added: ${displayName}`);
  } else {
    parts.push(`Customer updated: ${displayName}`);
  }
  if (companyName && companyName !== displayName) {
    parts.push(`(${companyName})`);
  }
  if (balance != null && balance > 0) {
    parts.push(`— ${currency(balance)} balance`);
  }

  return {
    id: generateULID(),
    timestamp,
    ingestedAt: new Date().toISOString(),
    source: "quickbooks",
    eventType: isNew ? "customer.created" : "customer.updated",
    scope: {
      org: realmId,
      project: "QuickBooks",
      actor: displayName,
    },
    payload: {
      qb_id: cust.Id,
      display_name: displayName,
      company_name: companyName || null,
      balance,
      active,
      email: (cust.PrimaryEmailAddr as { Address?: string })?.Address || null,
    },
    summary: parts.join(" "),
    tags: ["customer"],
  };
}

// --- Bill ---

export function normalizeBill(
  bill: Record<string, unknown>,
  realmId: string
): OpenChiefEvent {
  const meta = bill.MetaData as
    | { LastUpdatedTime?: string; CreateTime?: string }
    | undefined;
  const timestamp =
    meta?.LastUpdatedTime || meta?.CreateTime || new Date().toISOString();

  const vendorRef = bill.VendorRef as
    | { value?: string; name?: string }
    | undefined;
  const totalAmt = bill.TotalAmt as number | undefined;
  const balance = bill.Balance as number | undefined;
  const dueDate = bill.DueDate as string | undefined;
  const docNumber = (bill.DocNumber as string) || "";

  const parts: string[] = [];
  parts.push(`Bill${docNumber ? ` #${docNumber}` : ""}`);
  if (vendorRef?.name) parts.push(`from ${vendorRef.name}`);
  if (totalAmt != null) parts.push(`— ${currency(totalAmt)}`);
  if (balance != null && balance > 0) parts.push(`(${currency(balance)} unpaid)`);
  if (dueDate) parts.push(`due ${dueDate}`);

  const tags: string[] = ["bill", "expense"];
  if (balance != null && balance > 0 && dueDate) {
    const due = new Date(dueDate);
    if (due < new Date()) tags.push("overdue");
  }

  return {
    id: generateULID(),
    timestamp,
    ingestedAt: new Date().toISOString(),
    source: "quickbooks",
    eventType: "bill.updated",
    scope: {
      org: realmId,
      project: "QuickBooks",
      actor: vendorRef?.name || undefined,
    },
    payload: {
      qb_id: bill.Id,
      doc_number: docNumber,
      vendor: vendorRef?.name || null,
      vendor_id: vendorRef?.value || null,
      total: totalAmt,
      balance,
      due_date: dueDate,
      currency: (bill.CurrencyRef as { value?: string })?.value || "USD",
    },
    summary: parts.join(" "),
    tags,
  };
}

// --- P&L Report ---

interface QBReport {
  Header?: {
    ReportName?: string;
    StartPeriod?: string;
    EndPeriod?: string;
    Currency?: string;
    ReportBasis?: string;
  };
  Rows?: {
    Row?: Array<QBReportRow>;
  };
}

interface QBReportRow {
  type?: string;
  group?: string;
  Header?: { ColData?: Array<{ value?: string }> };
  Rows?: { Row?: Array<QBReportRow> };
  Summary?: { ColData?: Array<{ value?: string }> };
  ColData?: Array<{ value?: string; id?: string }>;
}

/**
 * Extract top-level section summaries from a QB report.
 * Returns e.g. { "Income": "12345.67", "Expenses": "8000.00", "Net Income": "4345.67" }
 */
function extractSectionTotals(report: QBReport): Record<string, string> {
  const totals: Record<string, string> = {};
  const rows = report.Rows?.Row || [];

  for (const row of rows) {
    if (row.type === "Section" && row.group) {
      // Section summary
      const summaryValue = row.Summary?.ColData?.[1]?.value;
      if (summaryValue) {
        totals[row.group] = summaryValue;
      }
    } else if (row.ColData && row.ColData.length >= 2) {
      // Flat row (like "Net Income")
      const label = row.ColData[0]?.value;
      const value = row.ColData[1]?.value;
      if (label && value) {
        totals[label] = value;
      }
    }
  }

  return totals;
}

export function normalizeProfitAndLoss(
  report: QBReport,
  realmId: string
): OpenChiefEvent | null {
  if (!report.Header) return null;

  const startPeriod = report.Header.StartPeriod || "";
  const endPeriod = report.Header.EndPeriod || "";
  const totals = extractSectionTotals(report);

  const income = totals["Income"] || totals["TotalIncome"] || "0";
  const expenses = totals["Expenses"] || totals["TotalExpenses"] || "0";
  const netIncome = totals["NetIncome"] || totals["Net Income"] || "0";

  const parts: string[] = [];
  parts.push(`P&L Report (${startPeriod} to ${endPeriod}):`);
  parts.push(`Revenue ${currency(income)},`);
  parts.push(`Expenses ${currency(expenses)},`);
  parts.push(`Net Income ${currency(netIncome)}`);

  const netNum = Number(netIncome);
  const tags: string[] = ["report", "pnl"];
  if (!isNaN(netNum) && netNum < 0) tags.push("net-loss");

  return {
    id: generateULID(),
    timestamp: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    source: "quickbooks",
    eventType: "report.profit_and_loss",
    scope: {
      org: realmId,
      project: "QuickBooks",
    },
    payload: {
      report_name: "ProfitAndLoss",
      start_period: startPeriod,
      end_period: endPeriod,
      basis: report.Header.ReportBasis || "Accrual",
      totals,
      income: Number(income) || 0,
      expenses: Number(expenses) || 0,
      net_income: Number(netIncome) || 0,
    },
    summary: parts.join(" "),
    tags,
  };
}

// --- Balance Sheet ---

export function normalizeBalanceSheet(
  report: QBReport,
  realmId: string
): OpenChiefEvent | null {
  if (!report.Header) return null;

  const endPeriod = report.Header.EndPeriod || report.Header.StartPeriod || "";
  const totals = extractSectionTotals(report);

  const totalAssets = totals["TotalAssets"] || totals["Assets"] || "0";
  const totalLiabilities =
    totals["TotalLiabilities"] || totals["Liabilities"] || "0";
  const totalEquity = totals["TotalEquity"] || totals["Equity"] || "0";

  const parts: string[] = [];
  parts.push(`Balance Sheet as of ${endPeriod}:`);
  parts.push(`Assets ${currency(totalAssets)},`);
  parts.push(`Liabilities ${currency(totalLiabilities)},`);
  parts.push(`Equity ${currency(totalEquity)}`);

  return {
    id: generateULID(),
    timestamp: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    source: "quickbooks",
    eventType: "report.balance_sheet",
    scope: {
      org: realmId,
      project: "QuickBooks",
    },
    payload: {
      report_name: "BalanceSheet",
      as_of: endPeriod,
      basis: report.Header.ReportBasis || "Accrual",
      totals,
      total_assets: Number(totalAssets) || 0,
      total_liabilities: Number(totalLiabilities) || 0,
      total_equity: Number(totalEquity) || 0,
    },
    summary: parts.join(" "),
    tags: ["report", "balance-sheet"],
  };
}
