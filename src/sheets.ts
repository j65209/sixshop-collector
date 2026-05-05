import { google, sheets_v4 } from "googleapis";
import { config } from "./config.js";
import { ORDER_HEADER, type OrderRow } from "./types.js";

let cached: sheets_v4.Sheets | null = null;

function getClient(): sheets_v4.Sheets {
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

export async function ensureSchema(): Promise<void> {
  await ensureSheet(config.sheets.ordersSheetName, ORDER_HEADER as unknown as string[]);
  await ensureSheet(config.sheets.stateSheetName, ["key", "value"]);
}

export async function appendOrders(rows: OrderRow[]): Promise<void> {
  if (rows.length === 0) return;
  const sheets = getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheets.sheetId,
    range: `${config.sheets.ordersSheetName}!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows as unknown as (string | number)[][] },
  });
}

export async function readExistingKeys(keyColumns: number[]): Promise<Set<string>> {
  // 주문로그 시트에서 (주문번호, 상품명, 옵션) 조합으로 dedup key 구성
  const sheets = getClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${config.sheets.ordersSheetName}!A2:L`,
  });
  const out = new Set<string>();
  for (const row of got.data.values ?? []) {
    const key = keyColumns.map((i) => row[i] ?? "").join("::");
    if (key.replace(/::/g, "")) out.add(key);
  }
  return out;
}

export async function getState(key: string): Promise<string | null> {
  const sheets = getClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${config.sheets.stateSheetName}!A2:B`,
  });
  for (const row of got.data.values ?? []) {
    if (row[0] === key) return row[1] ?? null;
  }
  return null;
}

export async function setState(key: string, value: string): Promise<void> {
  const sheets = getClient();
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheets.sheetId,
    range: `${config.sheets.stateSheetName}!A2:B`,
  });
  const rows = got.data.values ?? [];
  const idx = rows.findIndex((r) => r[0] === key);
  if (idx >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheets.sheetId,
      range: `${config.sheets.stateSheetName}!B${idx + 2}`,
      valueInputOption: "RAW",
      requestBody: { values: [[value]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.sheets.sheetId,
      range: `${config.sheets.stateSheetName}!A:B`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[key, value]] },
    });
  }
}
