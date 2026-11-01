/**
 * 식스샵 프로 주문 내보내기 — 기간(기본 한 달) 주문 전부를 개인정보 없이 비공개 레포 brightbeed-reports 의
 * exports/sixshop-pro-orders/{기간}/{브랜드}.json 으로 올린다. 엑셀은 받는 쪽에서 만든다 (주문 · 상품 줄이 따로 있어 반복 없음).
 *   맥미니에서 한 번 실행: mac/jobs/export-pro-orders.job (RUN_NOW). 상점 Access Key(공식 Open API)만 쓴다 — 로그인 안 함.
 *   기간 = 주문일(orderedAt) KST. 상태와 상관없이 전부 (입금 전 · 취소 · 환불 포함) — 결제일 · 상태로 거르는 건 받는 쪽에서.
 *   이미 올린 기간(manifest.json 의 브랜드가 모두 ok)이면 건너뛴다 — 작업 파일이 남아 다시 돌아도 같은 걸 또 받지 않게.
 *
 * 담는 값 — src/sixshop-pro-orders.ts slimOrder 와 같은 원칙 (구매자 · 수령인 이름 · 연락처 · 주소 · 메모 · 작성형 옵션 · 송장은 안 담음):
 *   1. 알려진 주문 · 상품 줄 필드 (ORDER_FIELDS · ITEM_FIELDS)
 *   2. 그 밖의 필드는 키 이름에 개인정보 낱말(PII_WORDS)이 없고, 값이 숫자 · 참거짓 · 시각(…At) · 짧은 상태/코드(…Status · Type · Code …)일 때만.
 *      안쪽 객체는 "a.b" 로 펴서 같은 규칙. 배열 · 그 밖의 글자는 안 담는다.
 *   안 담은 키는 이름만 excluded_keys 에 적는다 (값은 안 적음) — 무엇이 빠졌는지 받는 쪽이 알 수 있게.
 *
 * 사용법:
 *   npm run export-pro-orders -- --month 2026-10                      # 코페리 · 아페티 · 코즈미, 2026-10-01 ~ 10-31
 *   npm run export-pro-orders -- --month 2026-10 --brands kop,apt,koz,pp
 *   npm run export-pro-orders -- --from 2026-10-01 --to 2026-10-15     # 기간 (KST 날짜, 양끝 포함)
 *   npm run export-pro-orders -- --month 2026-10 --dry                # 받기만 — 기록 없음, 건수만 출력
 *   npm run export-pro-orders -- --month 2026-10 --force              # 이미 올린 기간도 다시
 * env: SIXSHOP_PRO_ACCESS_KEY_{KOP·APT·KOZ…} (src/home-brands.ts credEnvSuffix) · REPORTS_GITHUB_TOKEN
 * 시험: npx tsx tests/export-pro-orders.test.ts
 */
import "dotenv/config";
import { HOME_BRANDS, type HomeBrand } from "./home-brands.js";
import { commitFiles, ghGetJson } from "./reports-repo.js";
import { openApiHeaders, ORDERS_URL } from "./sixshop-pro-orders.js";

export const EXPORT_DIR = "exports/sixshop-pro-orders";
export const DEFAULT_BRANDS = ["kop", "apt", "koz"];
const DAY = 86400_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 200;

// 알려진 필드 — 그대로 담음 (src/sixshop-pro-orders.ts RawOrder · RawProduct 와 같음)
export const ORDER_FIELDS = [
  "orderId", "orderedAt", "paidAt", "cancelledAt", "paymentStatus", "processStatus", "paymentTypes", "marketCode",
  "orderAmount", "deliveryFee", "discountAmount", "discountDeliveryFee", "sectionDeliveryFee", "totalAmount", "totalDiscountAmount", "refundAmount",
];
export const ITEM_FIELDS = [
  "productOrderId", "productName", "productOptionNames", "productOptionValues", "productOptionDisplayName", "quantity",
  "unitPrice", "originalUnitPrice", "unitAmount", "discountAmount", "status", "claimType", "sku", "productManageCode",
];

// 키 이름(낱말로 나눔)에 이 중 하나라도 있으면 값이 숫자여도 안 담는다
const PII_WORDS = new Set([
  "name", "names", "nick", "nickname", "phone", "tel", "telephone", "mobile", "cell", "cellphone", "contact", "email", "mail",
  "address", "addr", "address1", "address2", "zip", "zipcode", "postcode", "postal", "road", "jibun", "street", "building", "city",
  "lat", "lng", "latitude", "longitude", "location", "geo", "coordinate", "coordinates",
  "memo", "message", "msg", "note", "notes", "comment", "comments", "request", "requests", "remark", "remarks", "reason", "answer",
  "receiver", "recipient", "orderer", "buyer", "customer", "member", "user", "guest", "person", "personal", "privacy", "sender", "depositor",
  "ip", "agent", "device", "account", "bank", "card", "holder", "birth", "birthday", "birthdate", "gender", "sex", "age",
  "invoice", "tracking", "waybill", "courier", "carrier", "customs", "clearance", "pccc",
  "input", "custom", "additional", "text", "password", "token", "secret", "key", "credential", "auth",
  "identity", "identification", "cert", "certification", "ssn", "rrn", "social", "profile", "image", "photo", "url", "link",
]);
// 글자 값은 키의 마지막 낱말이 이것이고 짧을 때만 (상태 · 종류 · 코드)
const CODE_WORDS = new Set(["status", "type", "types", "code", "method", "market", "channel", "kind", "state", "currency"]);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** "deliveryFee" → ["delivery","fee"] · "ordererTel" → ["orderer","tel"] · "storeMarket.marketCode" → ["store","market","market","code"] */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s._\-[\]]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}
export const piiKey = (path: string) => keyWords(path).some((w) => PII_WORDS.has(w));

/** 객체에서 담을 값만 (알려진 필드 + 규칙에 맞는 필드). 안 담은 키 이름은 excluded 에 */
export function pickSafe(obj: Record<string, unknown> | null | undefined, known: readonly string[], excluded: Set<string>, prefix = "", depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!prefix && known.includes(k)) {
      out[k] = v ?? null;
      continue;
    }
    if (v === null || v === undefined || v === "") continue;
    if (piiKey(path)) {
      excluded.add(path);
      continue;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      out[path] = v;
      continue;
    }
    if (typeof v === "string") {
      const words = keyWords(k);
      const last = words[words.length - 1] ?? "";
      if (last === "at" && ISO_TIME.test(v)) out[path] = v;
      else if (CODE_WORDS.has(last) && v.length <= 40) out[path] = v;
      else excluded.add(path);
      continue;
    }
    if (!Array.isArray(v) && typeof v === "object" && depth < 2) {
      Object.assign(out, pickSafe(v as Record<string, unknown>, known, excluded, path, depth + 1));
      continue;
    }
    excluded.add(path);
  }
  return out;
}

interface RawListItem {
  order?: Record<string, unknown>;
  productOrders?: Record<string, unknown>[] | null;
  [k: string]: unknown;
}

export interface ExcludedKeys { order: Set<string>; item: Set<string>; other: Set<string> }
export const newExcluded = (): ExcludedKeys => ({ order: new Set(), item: new Set(), other: new Set() });

/** 주문 하나 — 주문 필드 + 목록 줄의 다른 값(storeMarket 등, "storeMarket.x" 로 폄) + 상품 줄 */
export function exportOrder(x: RawListItem, ex: ExcludedKeys): Record<string, unknown> {
  const { order, productOrders, ...rest } = x;
  return {
    ...pickSafe(order, ORDER_FIELDS, ex.order),
    ...pickSafe(rest, [], ex.other),
    items: (productOrders ?? []).map((p) => pickSafe(p, ITEM_FIELDS, ex.item)),
  };
}

/** KST 날짜 00:00 의 UTC ISO · KST 날짜 23:59:59.999 의 UTC ISO */
export const kstStartIso = (date: string) => new Date(Date.parse(`${date}T00:00:00+09:00`)).toISOString();
export const kstEndIso = (date: string) => new Date(Date.parse(`${date}T00:00:00+09:00`) + DAY - 1).toISOString();
/** UTC ISO → "YYYY-MM-DD HH:MM:SS" (KST) */
export const kst = (iso: unknown) =>
  typeof iso === "string" && iso ? new Date(Date.parse(iso) + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 19) : "";

export interface ExportArgs { from: string; to: string; label: string; brands: string[]; dry: boolean; force: boolean }

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export function parseArgs(argv: string[], brands: Record<string, unknown> = HOME_BRANDS): ExportArgs {
  const val = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? "" : null);
  const month = val("--month");
  let from = val("--from");
  let to = val("--to");
  let label: string;
  if (month != null) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`--month 는 YYYY-MM (받은 값: ${month})`);
    if (from != null || to != null) throw new Error("--month 와 --from/--to 는 같이 쓸 수 없어요");
    const [y, m] = month.split("-").map(Number);
    from = `${month}-01`;
    to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // 그달 마지막 날
    label = month;
  } else {
    if (from == null || to == null) throw new Error("--month YYYY-MM 또는 --from YYYY-MM-DD --to YYYY-MM-DD 가 필요해요");
    label = `${from}_${to}`;
  }
  if (!isDate(from) || !isDate(to)) throw new Error(`날짜는 YYYY-MM-DD (받은 값: ${from} ~ ${to})`);
  if (from > to) throw new Error(`시작이 끝보다 늦어요 (${from} > ${to})`);
  const list = val("--brands");
  const picked = list != null ? list.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_BRANDS;
  if (!picked.length) throw new Error("--brands 가 비었어요");
  for (const b of picked) if (!brands[b]) throw new Error(`없는 브랜드: ${b} (${Object.keys(brands).join(", ")})`);
  return { from, to, label, brands: picked, dry: argv.includes("--dry"), force: argv.includes("--force") };
}

export interface ExportDeps {
  fetch: typeof fetch;
  getJson: <T>(path: string) => Promise<T | null>;
  commit: (files: { path: string; content: unknown }[], message: string) => Promise<string | null>;
  env: (name: string) => string | undefined;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  brands: Record<string, HomeBrand>;
}

/** 주문일 fromIso ~ toIso 의 주문 목록 원본 전부 (페이지 넘기며). 429 · 5xx 는 조금 쉬고 다시 (최대 4번) */
export async function fetchAllRaw(
  headers: Record<string, string>, fromIso: string, toIso: string, deps: Pick<ExportDeps, "fetch" | "sleep">,
): Promise<{ list: RawListItem[]; pages: number; apiTotal: number | null; dupes: number }> {
  const byId = new Map<string, RawListItem>();
  let page = 1;
  let totalPages = 1;
  let apiTotal: number | null = null;
  let dupes = 0;
  do {
    const q = `page=${page}&limit=${PAGE_LIMIT}&sort=-orderedAt&orderedAtMin=${encodeURIComponent(fromIso)}&orderedAtMax=${encodeURIComponent(toIso)}`;
    let r: Response | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      r = await deps.fetch(`${ORDERS_URL.accessKey}?${q}`, { headers });
      if ((r.status === 429 || r.status >= 500) && attempt < 4) {
        await deps.sleep(3000 * attempt);
        continue;
      }
      break;
    }
    if (!r!.ok) {
      const hint = r!.status === 401 || r!.status === 403 || r!.status === 400 ? " — Access Key 가 틀렸거나 다른 상점 것" : "";
      throw new Error(`식스샵 프로 주문 API ${r!.status}${hint} ${(await r!.text()).slice(0, 200)}`);
    }
    type Page = { list: RawListItem[]; pagination?: { totalPages?: number; totalItems?: number; totalCount?: number } };
    const j = (await r!.json()) as Page | { data: Page };
    const d = "data" in j && j.data ? j.data : (j as Page);
    if (!Array.isArray(d.list)) throw new Error(`식스샵 프로 주문 API 응답에 list 가 없어요 (page ${page})`);
    for (const x of d.list) {
      const id = String(x?.order?.orderId ?? "");
      if (!id) throw new Error(`orderId 없는 주문 (page ${page})`);
      if (byId.has(id)) dupes++;
      byId.set(id, x);
    }
    totalPages = Number(d.pagination?.totalPages) || 1;
    if (page === 1) {
      const t = Number(d.pagination?.totalItems ?? d.pagination?.totalCount);
      apiTotal = Number.isFinite(t) ? t : null;
    }
    page++;
    if (page > MAX_PAGES) throw new Error(`주문이 ${MAX_PAGES * PAGE_LIMIT}건을 넘어요 — 기간을 나눠 받으세요`);
    if (page <= totalPages) await deps.sleep(300);
  } while (page <= totalPages);
  return { list: [...byId.values()], pages: totalPages, apiTotal, dupes };
}

export interface ManifestBrand {
  brand: string;
  name: string;
  store: string;
  ok: boolean;
  file?: string;
  orders?: number;
  items?: number;
  api_total?: number | null;
  first_ordered_at?: string;
  last_ordered_at?: string;
  error?: string;
}
export interface Manifest {
  kind: "sixshop-pro-orders";
  period: { from: string; to: string; basis: string };
  generated_at: string;
  brands: ManifestBrand[];
}

export async function runExport(args: ExportArgs, deps: ExportDeps): Promise<{ ok: boolean; skipped: boolean; manifest: Manifest }> {
  const dir = `${EXPORT_DIR}/${args.label}`;
  const basis = "주문일(orderedAt) KST — 상태 무관 전부 (입금 전 · 취소 · 환불 포함)";
  if (!args.dry && !args.force) {
    const prev = await deps.getJson<Manifest>(`${dir}/manifest.json`);
    const done = new Set((prev?.brands ?? []).filter((b) => b.ok).map((b) => b.brand));
    if (prev && args.brands.every((b) => done.has(b))) {
      deps.log(`[export-pro-orders] ${dir} 는 이미 올렸어요 (${prev.generated_at}) — 건너뜀. 다시 받으려면 --force`);
      return { ok: true, skipped: true, manifest: prev };
    }
  }

  const fromIso = kstStartIso(args.from);
  const toIso = kstEndIso(args.to);
  const generatedAt = deps.now().toISOString();
  const results: ManifestBrand[] = [];
  for (const id of args.brands) {
    const cfg = deps.brands[id];
    const base = { brand: id, name: cfg.name, store: cfg.proStore };
    try {
      const keyName = `SIXSHOP_PRO_ACCESS_KEY${cfg.credEnvSuffix}`;
      const key = deps.env(keyName);
      if (!key) throw new Error(`Access Key 없음 (.env 의 ${keyName})`);
      const raw = await fetchAllRaw(openApiHeaders(key, cfg.proStore), fromIso, toIso, deps);
      const ex = newExcluded();
      const t = (o: Record<string, unknown>) => Date.parse(String(o.orderedAt));
      const orders = raw.list.map((x) => exportOrder(x, ex)).sort((a, b) => t(a) - t(b) || String(a.orderId).localeCompare(String(b.orderId)));
      const items = orders.reduce((s, o) => s + (o.items as unknown[]).length, 0);
      const outside = orders.filter((o) => !(t(o) >= Date.parse(fromIso) && t(o) <= Date.parse(toIso))).length;
      const warnings: string[] = [];
      if (raw.apiTotal != null && raw.apiTotal !== orders.length) warnings.push(`API 총 ${raw.apiTotal}건 ≠ 받은 ${orders.length}건`);
      if (raw.dupes) warnings.push(`페이지 사이 중복 ${raw.dupes}건 (주문번호로 합침)`);
      if (outside) warnings.push(`기간 밖 주문 ${outside}건 (그대로 둠)`);
      const file = `${dir}/${id}.json`;
      const content = {
        kind: "sixshop-pro-orders",
        brand: id,
        name: cfg.name,
        store: cfg.proStore,
        period: { from: args.from, to: args.to, basis },
        query: { orderedAtMin: fromIso, orderedAtMax: toIso, sort: "-orderedAt", limit: PAGE_LIMIT, pages: raw.pages },
        generated_at: generatedAt,
        counts: { orders: orders.length, items, api_total: raw.apiTotal },
        warnings,
        privacy: "구매자 · 수령인 이름 · 연락처 · 주소 · 메모 · 작성형 옵션 · 송장 등은 담지 않음 — 안 담은 키 이름만 excluded_keys",
        excluded_keys: { order: [...ex.order].sort(), item: [...ex.item].sort(), other: [...ex.other].sort() },
        orders,
      };
      const first = orders[0]?.orderedAt;
      const last = orders[orders.length - 1]?.orderedAt;
      deps.log(
        `[export-pro-orders] ${cfg.name}(${cfg.proStore}): 주문 ${orders.length}건 · 상품 줄 ${items}개 · ${raw.pages}페이지` +
          (orders.length ? ` · ${kst(first)} ~ ${kst(last)}` : "") + (warnings.length ? ` · 주의: ${warnings.join(" / ")}` : ""),
      );
      if (!args.dry) {
        await deps.commit([{ path: file, content }], `주문 내보내기 ${args.label}: ${cfg.name} ${orders.length}건`);
        deps.log(`[export-pro-orders]   → ${file}`);
      }
      results.push({ ...base, ok: true, file, orders: orders.length, items, api_total: raw.apiTotal, first_ordered_at: kst(first), last_ordered_at: kst(last) });
    } catch (e) {
      const error = (e as Error).message;
      deps.log(`[export-pro-orders] ${cfg.name}(${cfg.proStore}) 실패: ${error}`);
      results.push({ ...base, ok: false, error });
    }
  }

  const manifest: Manifest = { kind: "sixshop-pro-orders", period: { from: args.from, to: args.to, basis }, generated_at: generatedAt, brands: results };
  if (!args.dry) {
    // 앞서 ok 로 올린 브랜드는 이번에 안 받았으면 그대로 둔다 (--brands 로 일부만 다시 받을 때)
    const prev = await deps.getJson<Manifest>(`${dir}/manifest.json`);
    const now = new Set(results.map((b) => b.brand));
    manifest.brands = [...(prev?.brands ?? []).filter((b) => !now.has(b.brand)), ...results];
    await deps.commit([{ path: `${dir}/manifest.json`, content: manifest }], `주문 내보내기 ${args.label}: manifest`);
  }
  return { ok: results.every((b) => b.ok), skipped: false, manifest };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const res = await runExport(args, {
    fetch: (input, init) => fetch(input, init),
    getJson: ghGetJson,
    commit: commitFiles,
    env: (name) => process.env[name],
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    brands: HOME_BRANDS,
  });
  if (!res.ok) {
    const failed = res.manifest.brands.filter((b) => !b.ok).map((b) => `${b.name}: ${b.error}`);
    throw new Error(`${failed.length}개 상점 실패 — ${failed.join(" / ")}`);
  }
}

// 시험(tests/export-pro-orders.test.ts)은 함수만 불러 쓰려고 EXPORT_PRO_ORDERS_NO_MAIN=1 을 켠다
if (process.env.EXPORT_PRO_ORDERS_NO_MAIN !== "1") {
  main().catch((e) => {
    console.error("[export-pro-orders] 실패:", (e as Error).message);
    process.exit(1);
  });
}
