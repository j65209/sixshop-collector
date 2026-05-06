import "dotenv/config";
import bcrypt from "bcryptjs";
import { google } from "googleapis";
import { readFileSync, writeFileSync } from "node:fs";

const clientId = process.env.NAVER_CLIENT_ID_PP!;
const clientSecret = process.env.NAVER_CLIENT_SECRET_PP!;
const BASE = "https://api.commerce.naver.com/external";

async function token(): Promise<string> {
  const ts = Date.now();
  const password = `${clientId}_${ts}`;
  const hashed = bcrypt.hashSync(password, clientSecret);
  const sig = Buffer.from(hashed, "utf-8").toString("base64");
  const body = new URLSearchParams({
    client_id: clientId,
    timestamp: String(ts),
    client_secret_sign: sig,
    grant_type: "client_credentials",
    type: "SELF",
  });
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return ((await r.json()) as { access_token: string }).access_token;
}

interface SsProduct {
  originProductNo: number;
  name: string;
  status: string;
  options: string[];
}

async function fetchAllSsProducts(t: string): Promise<SsProduct[]> {
  const out: SsProduct[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${BASE}/v1/products/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ size: 100, page }),
    });
    if (!r.ok) break;
    const d = (await r.json()) as {
      contents?: Array<{
        originProductNo: number;
        channelProducts?: Array<{
          name: string;
          statusType: string;
          optionInfo?: { optionCombinations?: Array<{ optionName1?: string; optionName2?: string; optionName3?: string }> };
        }>;
      }>;
      last?: boolean;
    };
    for (const c of d.contents ?? []) {
      const cp = c.channelProducts?.[0];
      if (!cp) continue;
      const combos = cp.optionInfo?.optionCombinations ?? [];
      const opts = combos.map((co) => [co.optionName1, co.optionName2, co.optionName3].filter(Boolean).join(" / "));
      out.push({
        originProductNo: c.originProductNo,
        name: cp.name,
        status: cp.statusType,
        options: opts,
      });
    }
    if (d.last) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return out;
}

async function fetchSixshopRows(): Promise<{ name: string; option: string }[]> {
  const creds = JSON.parse(readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_PATH!, "utf8"));
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "PP 재고마스터!B2:C",
  });
  return (r.data.values ?? [])
    .filter((row) => row[0])
    .map((row) => ({ name: String(row[0]), option: String(row[1] ?? "") }));
}

async function main(): Promise<void> {
  const t = await token();
  console.log("fetching SS products...");
  const ssProducts = await fetchAllSsProducts(t);
  console.log(`SS products: ${ssProducts.length}`);

  console.log("fetching 식스샵 rows...");
  const sixRows = await fetchSixshopRows();
  console.log(`식스샵 rows: ${sixRows.length}`);

  // 유니크한 식스샵 상품명 (옵션 무시)
  const sixUnique = Array.from(new Set(sixRows.map((r) => r.name)));
  console.log(`식스샵 unique products: ${sixUnique.length}`);

  const out = {
    ss: ssProducts,
    six_unique_products: sixUnique,
    six_all_rows: sixRows,
  };
  writeFileSync("_products.json", JSON.stringify(out, null, 2));
  console.log("\nwrote _products.json");
  console.log("\n=== SS PRODUCTS ===");
  for (const p of ssProducts) {
    console.log(`[${p.originProductNo}] ${p.name}  (${p.status}, ${p.options.length} opts)`);
    if (p.options.length > 0 && p.options.length <= 5) {
      for (const o of p.options) console.log(`    - ${o}`);
    } else if (p.options.length > 5) {
      console.log(`    - ${p.options.slice(0, 3).join(" | ")}  ...+${p.options.length - 3} more`);
    }
  }
  console.log("\n=== 식스샵 UNIQUE PRODUCTS ===");
  for (const n of sixUnique) console.log(`- ${n}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
