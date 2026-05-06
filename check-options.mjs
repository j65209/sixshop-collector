import "dotenv/config";
import { google } from "googleapis";
import { readFileSync } from "node:fs";

const path = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
const expanded = path.startsWith("~") ? path.replace(/^~/, process.env.HOME) : path;
const creds = JSON.parse(readFileSync(expanded, "utf8"));
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth });

for (const tab of ["6A 재고마스터", "CT 재고마스터"]) {
  const got = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: `${tab}!A2:E`,
  });
  const optionRows = (got.data.values ?? []).filter((r) => (r[2] ?? "").trim());
  console.log(`\n[${tab}] 옵션 있는 row ${optionRows.length}건:`);
  optionRows.forEach((r) => console.log(`  ${r[1]} / ${r[2]} / 재고: ${r[4]}`));
}
