/**
 * 식스에이 (6thanother) 식스샵 단독 — 모든 판매중 SKU 카탈로그 추출 → sixA-products.json
 *
 * 옵션 없는 단일상품: stock = CSV 수량
 * 옵션 있는 상품: options[] = 옵션별 stock + optionNo (식스샵 admin update용 키)
 *
 * Brightbeed dashboard의 식스에이 뷰가 사용. workflow_dispatch / cron 트리거.
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

const CAT_HINTS: [RegExp, string][] = [
  [/necklace/i, "Necklace"],
  [/bracelet|bangle/i, "Bracelet"],
  [/ring/i, "Ring"],
  [/key\s*chain|keychain/i, "Keychain"],
  [/smart\s*tok|smarttok/i, "SmartTok"],
  [/hair\s*pin|hairpin/i, "HairPin"],
];

function categorize(name: string, csvCategory: string): string {
  // CSV 카테고리가 유효한 슬롯 중 하나면 우선 사용
  for (const [, slot] of CAT_HINTS) if (csvCategory === slot) return slot;
  for (const [re, slot] of CAT_HINTS) if (re.test(name)) return slot;
  return "Misc";
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
  const brand = BRANDS.find((b) => b.siteLink === "6thanother");
  if (!brand) throw new Error("6thanother brand not found");

  const browser = await newBrowser();
  const page = await newBrandPage(browser);

  try {
    console.log(`[list-six6-skus] login as ${brand.displayName}`);
    await loginAsBrand(page, brand);

    console.log(`[list-six6-skus] download products CSV`);
    const csvPath = await downloadProductsCsv(page);
    const csvRows = parseCsvRows(csvPath);
    await unlink(csvPath).catch(() => {});
    console.log(`[list-six6-skus] CSV rows: ${csvRows.length}`);

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

    // 상태 매칭은 공백·표기 차이에 둔감하게 — "판매 중"/"판매중" 등.
    const statusNorm = (s: string) => s.replace(/\s+/g, "");
    const allowed = new Set(brand.includeStatuses.map(statusNorm));
    const targets = Array.from(byProductNo.entries()).filter(([, m]) => allowed.has(statusNorm(m.status)));
    console.log(`[list-six6-skus] target products (status=${brand.includeStatuses.join("|")}): ${targets.length}`);

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
          cat: categorize(meta.name, meta.category),
          stock: options.length > 0 ? null : meta.stockSum,
          options,
        });
      }
    }

    // 판매중 + (재고있음 OR 0재고) 모두 포함 — "판매중인 제품 싹다" 사용자 요청.
    // 옵션 0개로 떨어진 옵션상품(=mall API 실패) 또는 데이터 결손은 그대로 두되,
    // 단일상품이면서 name/id 없는 누락 row만 안전 제외.
    const visible = products.filter((p) => !!p.id && !!p.name);
    // 정렬: 카테고리 슬롯 순서 → 상품명
    const CAT_ORDER = ["Necklace", "Bracelet", "Ring", "Keychain", "SmartTok", "HairPin", "Misc"];
    visible.sort((a, b) => {
      const ca = CAT_ORDER.indexOf(a.cat);
      const cb = CAT_ORDER.indexOf(b.cat);
      if (ca !== cb) return ca - cb;
      return a.name.localeCompare(b.name);
    });

    const withOptions = visible.filter((p) => p.options.length > 0).length;
    const json = {
      version: 2,
      brand: "식스에이",
      platform: "식스샵 (6thanother)",
      description: `식스에이 = 식스샵(6thanother) 단독 판매 SKU. 판매중 ${visible.length}개 (옵션상품 ${withOptions}개 포함, 재고 0 포함).`,
      lastUpdated: nowKstIso(),
      shopBaseUrl: "https://www.sixshop.com/_shop/editShopProduct/6thanother",
      products: visible,
    };

    const outPath = "sixA-products.json";
    writeFileSync(outPath, JSON.stringify(json, null, 2));
    console.log(`\n✓ wrote ${outPath}: ${visible.length} products (옵션 ${withOptions} / 단일 ${visible.length - withOptions})`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("list-six6-skus failed:", e);
  process.exit(1);
});
