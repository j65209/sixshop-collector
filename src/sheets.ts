import { google, sheets_v4 } from "googleapis";
import { config } from "./config.js";
import type { Brand } from "./brands.js";
import { ORDER_HEADER, type OrderRow } from "./types.js";
import { SS_ORDER_HEADER, type SsOrderRow } from "./smartstore.js";

let cached: sheets_v4.Sheets | null = null;

export function getClient(): sheets_v4.Sheets {
  if (cached) return cached;
  const creds = JSON.parse(config.sheets.serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  cached = google.sheets({ version: "v4", auth });
  return cached;
}

async function ensureSheet(name: string, headerRow?: (string | number)[]): Promise<void> {
  const sheets = getClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheets.sheetId });
  const exists = meta.data.sheets?.some((s) => s.properties?.title === name);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheets.sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: name } } }] },
    });
    if (headerRow) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.sheets.sheetId,
        range: `${name}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headerRow] },
      });
    }
    return;
  }
  if (headerRow) {
    const got = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheets.sheetId,
      range: `${name}!A1:Z1`,
    });
    if (!got.data.values || got.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.sheets.sheetId,
        range: `${name}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headerRow] },
      });
    }
  }
}

export async function ensureBrandSchema(brand: Brand): Promise<void> {
  await ensureSheet(brand.ordersSheetName, ORDER_HEADER as unknown as string[]);
  await ensureSheet(brand.stateSheetName, ["key", "value"]);
  if (brand.smartStore) {
    await ensureSheet(brand.smartStore.ssOrdersSheetName, SS_ORDER_HEADER as unknown as string[]);
  }
}

export async function appendSmartStoreOrders(brand: Brand, rows: SsOrderRow[]): Promise<void> {
  if (rows.length === 0 || !brand.smartStore) return;
  const sheets = getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.sheetId,
    range: `${brand.smartStore.ssOrdersSheetName}!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows as unknown as (string | number)[][] },
  });
}

/** SS 주문로그에서 이미 적재된 productOrderId(B열) 집합 — dedup 용 */
export async function readExistingSsOrderIds(brand: Brand): Promise<Set<string>> {
  if (!brand.smartStore) return new Set();
  const sheets = getClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${brand.smartStore.ssOrdersSheetName}!B2:B`,
  });
  const out = new Set<string>();
  for (const row of got.data.values ?? []) {
    const v = String(row[0] ?? "").trim();
    if (v) out.add(v);
  }
  return out;
}

export async function appendOrders(brand: Brand, rows: OrderRow[]): Promise<void> {
  if (rows.length === 0) return;
  const sheets = getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.sheetId,
    range: `${brand.ordersSheetName}!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows as unknown as (string | number)[][] },
  });
}

export async function readExistingKeys(brand: Brand, keyColumns: number[]): Promise<Set<string>> {
  const sheets = getClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${brand.ordersSheetName}!A2:L`,
  });
  const out = new Set<string>();
  for (const row of got.data.values ?? []) {
    const key = keyColumns.map((i) => row[i] ?? "").join("::");
    if (key.replace(/::/g, "")) out.add(key);
  }
  return out;
}

export async function getBrandState(brand: Brand, key: string): Promise<string | null> {
  await ensureSheet(brand.stateSheetName, ["key", "value"]);
  const sheets = getClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${brand.stateSheetName}!A2:B`,
  });
  for (const row of got.data.values ?? []) {
    if (row[0] === key) return row[1] ?? null;
  }
  return null;
}

export async function setBrandState(brand: Brand, key: string, value: string): Promise<void> {
  await ensureSheet(brand.stateSheetName, ["key", "value"]);
  const sheets = getClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${brand.stateSheetName}!A2:B`,
  });
  const rows = got.data.values ?? [];
  const idx = rows.findIndex((r) => r[0] === key);
  if (idx >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheets.sheetId,
      range: `${brand.stateSheetName}!B${idx + 2}`,
      valueInputOption: "RAW",
      requestBody: { values: [[value]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.sheets.sheetId,
      range: `${brand.stateSheetName}!A:B`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[key, value]] },
    });
  }
}
