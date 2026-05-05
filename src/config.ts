import "dotenv/config";
import { readFileSync } from "node:fs";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function loadServiceAccountJson(): string {
  // 우선순위: GOOGLE_SERVICE_ACCOUNT_PATH(로컬용) → GOOGLE_SERVICE_ACCOUNT_JSON(Actions용)
  const path = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
  if (path) {
    const expanded = path.startsWith("~") ? path.replace(/^~/, process.env.HOME ?? "") : path;
    return readFileSync(expanded, "utf8");
  }
  return required("GOOGLE_SERVICE_ACCOUNT_JSON");
}

export const config = {
  sixshop: {
    email: required("SIXSHOP_EMAIL"),
    password: required("SIXSHOP_PASSWORD"),
    storeId: process.env.SIXSHOP_STORE_ID ?? "",
  },
  sheets: {
    serviceAccountJson: loadServiceAccountJson(),
    sheetId: required("SHEET_ID"),
    ordersSheetName: process.env.ORDERS_SHEET_NAME ?? "주문로그",
    stateSheetName: process.env.STATE_SHEET_NAME ?? "_state",
  },
  collect: {
    days: Number(process.env.COLLECT_DAYS ?? 3),
    headless: (process.env.HEADLESS ?? "true") !== "false",
  },
};

export type Config = typeof config;
