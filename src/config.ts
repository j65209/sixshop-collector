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
  // sheets는 실제 접근 시점에만 크리덴셜을 요구 (lazy).
  // 식스샵 재고 업데이트처럼 시트를 안 쓰는 워크플로가 import만으로 죽지 않도록.
  get sheets() {
    return {
      serviceAccountJson: loadServiceAccountJson(),
      sheetId: required("SHEET_ID"),
    };
  },
  collect: {
    headless: (process.env.HEADLESS ?? "true") !== "false",
  },
};

export type Config = typeof config;
