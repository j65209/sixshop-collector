/**
 * 클리어타입 (cleartype) 식스샵 단독 — 판매중/품절 SKU 카탈로그 추출 → cleartype-products.json
 *
 * 옵션 없는 단일상품: stock = CSV 수량
 * 옵션 있는 상품: options[] = 옵션별 stock + optionNo (식스샵 admin update용 키)
 *
 * Brightbeed dashboard 클리어타입 뷰가 사용. workflow_dispatch / cron 트리거.
 *
 * 식스에이 list-six6-skus.ts 와 동일 패턴이지만, jewelry 카테고리 힌트는 제거 (브랜드 무관 CSV 카테고리 그대로).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { Page } from "playwright";
import { read, utils } from "xlsx";
import { BRANDS } from "./brands.js";
import { downloadProductsCsv, loginAsBrand, newBrandPage, newBrowser } from "./sixshop.js";

interface OptionEntry {
  optionNo: string;
  label: string;
  stock: number;
}

interface ProductEntry {
  id: string;
  name: string;
  price: string;
  cat: string;
  status: string;
  stock: number | null;
  options: OptionEntry[];
}

interface MallProductDetail {
  shopProductOptionNameList?: Array<{ optionNameNo: number; optionName: string; optionNameOrderNo: number }>;
  shopProductOptionValueList?: Array<{ optionValueNo: number; optionValue: string }>;
  shopProductOptionList?: Array<{
    optionNo: number;
    optionValueNo1: number | null;
    optionValueNo2: number | null;
    optionValueNo3: number | null;
    optionQuantity: number;
  }>;
  shopProduct?: { productPrice: number };
}

async function fetchProductDetail(page: Page, memberNo: number, productNo: number): Promise<MallProductDetail | null> {
  return await page.evaluate(async ({ memberNo, productNo }) => {
    const r = await fetch(`/apis/mall/getShopProductByMemberNoAndProductNo?memberNo=${memberNo}&productNo=${productNo}`, {
      credentials: "include",
    });
    if (!r.ok) return null;
    return await r.json();
  }, { memberNo, productNo });
}

function buildOptionEntries(detail: MallProductDetail): OptionEntry[] {
  const nameList = (detail.shopProductOptionNameList ?? [])
    .slice()
    .sort((a, b) => (a.optionNameOrderNo ?? 0) - (b.optionNameOrderNo ?? 0));
  const valueMap = new Map<number, string>();
  for (const v of detail.shopProductOptionValueList ?? []) {
    valueMap.set(v.optionValueNo, String(v.optionValue ?? "").trim());
  }
  const out: OptionEntry[] = [];
  for (const opt of detail.shopProductOptionList ?? []) {
    const parts: string[] = [];
    for (let i = 0; i < nameList.length; i++) {
      const key = `optionValueNo${i + 1}` as "optionValueNo1" | "optionValueNo2" | "optionValueNo3";
      const valueNo = opt[key];
      if (valueNo == null) break;
      const value = valueMap.get(valueNo);
      if (!value) break;
      parts.push(`${nameList[i].optionName}: ${value}`);
    }
    if (parts.length === 0) continue;
    out.push({
      optionNo: String(opt.optionNo),
      label: parts.join(" / "),
      stock: Number(opt.optionQuantity) || 0,
    });
  }
  return out;
}

interface CsvRow {
  productNo: number;
  name: string;
  status: string;
  category: string;
  stock: number;
  price: string;
}

function parseCsvRows(path: string): CsvRow[] {
  const buf = readFileSync(path);
  const wb = read(buf, { type: "buffer", raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  return rows.map((r) => {
    const get = (...keys: string[]): string => {
      for (const k of keys) if (k in r) return String(r[k] ?? "").trim();
      return "";
    };
    const productNo = Number(get("상품고유번호")) || 0;
    const rawQty = get("수량");
    const stock = /관리\s*안/.test(rawQty) ? 99999 : Number(rawQty.replace(/[^\d.-]/g, "")) || 0;
    const rawPrice = get("판매가", "상품 가격", "가격");
    const priceNum = Number(rawPrice.replace(/[^\d.-]/g, "")) || 0;
    return {
      productNo,
      name: get("이름", "상품 이름"),
      status: get("상태"),
      category: get("카테고리"),
      stock,
      price: priceNum > 0 ? `${priceNum.toLocaleString("ko-KR")}원` : "",
    };
  });
}

function nowKstIso(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().replace("Z", "+09:00");
}

async function main(): Promise<void> {
  const brand = BRANDS.find((b) => b.siteLink === "cleartype");
  if (!brand) throw new Error("cleartype brand not found in BRANDS");

  const browser = await newBrowser();
  const page = await newBrandPage(browser);

  try {
    console.log(`[list-cleartype-skus] login as ${brand.displayName}`);
    await loginAsBrand(page, brand);

    console.log(`[list-cleartype-skus] download products CSV`);
    const csvPath = await downloadProductsCsv(page);
    const csvRows = parseCsvRows(csvPath);
    await unlink(csvPath).catch(() => {});
    console.log(`[list-cleartype-skus] CSV rows: ${csvRows.length}`);

    // 같은 productNo는 여러 row(옵션 풀어진 형태)로 올 수 있음 — 상품 단위로 집계
    const byProductNo = new Map<number, { name: string; status: string; category: string; price: string; stockSum: number }>();
    for (const r of csvRows) {
      if (!r.productNo || !r.name) continue;
      const existing = byProductNo.get(r.productNo);
      if (existing) {
        existing.stockSum += r.stock;
      } else {
        byProductNo.set(r.productNo, {
          name: r.name,
          status: r.status,
          category: r.category,
          price: r.price,
          stockSum: r.stock,
        });
      }
    }

    // brand.includeStatuses: 클리어타입은 ["판매 중", "품절"] (brands.ts 기준)
    const statusNorm = (s: string) => s.replace(/\s+/g, "");
    const allowed = new Set(brand.includeStatuses.map(statusNorm));
    const targets = Array.from(byProductNo.entries()).filter(([, m]) => allowed.has(statusNorm(m.status)));
    console.log(`[list-cleartype-skus] target products (status=${brand.includeStatuses.join("|")}): ${targets.length}`);

    const products: ProductEntry[] = [];
    // mall API 호출 (5개 병렬)
    for (let i = 0; i < targets.length; i += 5) {
      const batch = targets.slice(i, i + 5);
      const details = await Promise.all(
        batch.map(async ([productNo]) => {
          try {
            const detail = await fetchProductDetail(page, brand.memberNo, productNo);
            return { productNo, detail };
          } catch (e) {
            console.warn(`  detail fetch failed for ${productNo}: ${(e as Error).message}`);
            return { productNo, detail: null };
          }
        }),
      );
      for (const { productNo, detail } of details) {
        const meta = byProductNo.get(productNo)!;
        const options = detail ? buildOptionEntries(detail) : [];
        const apiPrice = detail?.shopProduct?.productPrice;
        const priceStr = apiPrice && apiPrice > 0 ? `${apiPrice.toLocaleString("ko-KR")}원` : meta.price;
        products.push({
          id: String(productNo),
          name: meta.name,
          price: priceStr,
          cat: meta.category || "기타",
          status: meta.status,
          stock: options.length > 0 ? null : meta.stockSum,
          options,
        });
      }
    }

    const visible = products.filter((p) => !!p.id && !!p.name);
    // 정렬: 상태(판매중 우선) → 카테고리 → 상품명
    visible.sort((a, b) => {
      const aOn = statusNorm(a.status) === "판매중" ? 0 : 1;
      const bOn = statusNorm(b.status) === "판매중" ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      const catCmp = (a.cat || "").localeCompare(b.cat || "");
      if (catCmp !== 0) return catCmp;
      return a.name.localeCompare(b.name);
    });

    const withOptions = visible.filter((p) => p.options.length > 0).length;
    const json = {
      version: 1,
      brand: "클리어타입",
      platform: "식스샵 (cleartype)",
      description: `클리어타입 = 식스샵(cleartype) 단독 판매 SKU. 총 ${visible.length}개 (판매중+품절, 옵션상품 ${withOptions}개 포함).`,
      lastUpdated: nowKstIso(),
      shopBaseUrl: "https://www.sixshop.com/_shop/editShopProduct/cleartype",
      products: visible,
    };

    const outPath = "cleartype-products.json";
    writeFileSync(outPath, JSON.stringify(json, null, 2));
    console.log(`\n✓ wrote ${outPath}: ${visible.length} products (옵션 ${withOptions} / 단일 ${visible.length - withOptions})`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("list-cleartype-skus failed:", e);
  process.exit(1);
});
