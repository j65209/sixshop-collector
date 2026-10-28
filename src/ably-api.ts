/**
 * 에이블리 셀러 어드민 API (비공식, docs/ABLY-API.md) — 로그인 · 토큰 저장 · 주문 / 정산 / 광고비 / 기획전 / 쿠폰 받기.
 * 계산은 src/ably-report.ts, 실행 파일은 src/ably-daily.ts(매일 07:10) · src/ably-live.ts(30분마다).
 *
 * 로그인 (2026-10-28 맥미니에서 확인 — 값은 출력하지 않고 응답 키만 봄):
 *   POST /seller/login/ {email, password} → {access_token, refresh_token}   (아이디 필드는 email 하나. username · id 는 400 "이메일은 필수 항목입니다")
 *   access_token = JWT 1시간 · refresh_token = JWT 7일. GET 헤더는 `Authorization: JWT <access_token>` (Bearer 는 401)
 *   POST /seller/refresh/ {refresh_token} → {access_token, refresh_token?} — 셀러 어드민 화면(my.a-bly.com app.js loginService.refresh)과 같은 갱신
 *   비밀번호 불일치는 {code: 2}
 *
 * 맥미니 상태 폴더의 토큰 파일 ~/brightbeed-auto/state/ably-token.json — 마켓마다 따로 (코페리 ably-token.json · 아페티 ably-token-apt.json …)
 * (권한 600, src/sixshop-pro.ts 와 같은 규칙):
 *   - access_token 이 수명의 1/4(15분) 넘게 남았으면 그대로, 아니면 refresh_token 으로 갱신, 그것도 안 되면 로그인 — 30분마다 로그인하지 않게.
 *   - 로그인 방식 + 이메일 해시로 계정에 묶음 (.env 계정이 바뀌면 버림). 401 이면 한 번만 새로 받아 다시.
 *   - 로그인이 실패하면 같은 비밀번호로는 6시간 동안 다시 시도하지 않는다 (계정 잠금 방지). .env 비밀번호를 고치면 바로 다시.
 *   - persist=false(--dry)면 파일을 쓰지 않는다.
 *
 *   - 같은 계정으로 따로 로그인해도 다른 세션(사람이 쓰는 셀러 어드민 · ably-collector)은 끊기지 않는다 (2026-10-28 확인).
 *
 * env: ABLY_EMAIL · ABLY_PASSWORD (마켓마다 뒤에 envSuffix, src/ably-brands.ts) · (선택) ABLY_TOKEN_FILE (코페리 토큰 파일 위치)
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { jwtExp, tokenUsable } from "./sixshop-pro.js";

export const ABLY_API = "https://api.a-bly.com";
const LOGIN_BACKOFF_MS = 6 * 3600_000;
// refresh_token 이 이만큼도 안 남았으면 갱신하지 않고 로그인
const REFRESH_MIN_LEFT_MS = 3600_000;
const LOGIN_FIELD = "email";

/** 코페리(envSuffix "") = ably-token.json · 다른 마켓 = ably-token-{apt|6a}.json */
const tokenFile = (envSuffix: string) =>
  (envSuffix ? undefined : process.env.ABLY_TOKEN_FILE) ??
  join(homedir(), "brightbeed-auto", "state", `ably-token${envSuffix.toLowerCase().replace(/_/g, "-")}.json`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

/* ---------------- 받는 데이터 ---------------- */

/** 주문상품 — 이 필드만 담는다 (buyer_* · receiver_* · memo 등 개인정보는 받은 즉시 버림, pickOrderItem) */
export interface AblyOrderItem {
  sno: number;
  order_sno: number;
  ea: number;
  status: string;
  ordered_at: string;
  checked_at: string;
  goods_sno: number;
  goods_name: string;
  goods_custom_code: string | null;
  option_info: string;
  price: number;
  exact_coupon_discount: number;
  exact_emoney_discount: number;
  exact_pay_benefit_discount: number;
  exact_amount: number;
  coupon_amount_for_ably: number;
  delivery_type: string;
  pay_method_name: string;
  balance_accounts_scheduled_at: string | null;
}

const ORDER_ITEM_KEYS: (keyof AblyOrderItem)[] = [
  "sno", "order_sno", "ea", "status", "ordered_at", "checked_at", "goods_sno", "goods_name", "goods_custom_code", "option_info", "price",
  "exact_coupon_discount", "exact_emoney_discount", "exact_pay_benefit_discount", "exact_amount", "coupon_amount_for_ably", "delivery_type",
  "pay_method_name", "balance_accounts_scheduled_at",
];

export function pickOrderItem(raw: Record<string, unknown>): AblyOrderItem {
  return Object.fromEntries(ORDER_ITEM_KEYS.map((k) => [k, raw[k] ?? null])) as unknown as AblyOrderItem;
}

export interface SettlementHistory {
  is_completed: boolean;
  scheduled_at: string;
  payment_amount: number;
  payment_fees: number;
  platform_fees: number;
  category_fees: number;
}

export interface AblyAdRow { datetime: string; charge: number; order_price: number }

export interface AblyEvent {
  sno: number;
  name: string;
  event_type: string;
  discount_type: string;
  event_start_date: string;
  event_end_date: string;
  is_applied: boolean;
  applied_status: string | null;
  applied_goods_count: number;
  approved_goods_count: number;
}

export interface AblyCoupon {
  sno: number;
  management_name: string;
  discount_type: string;
  discount_price: number;
  discount_percent: number;
  minimum_price: number;
  used_count: number;
  total_count: number;
  coupon_discount: number;
  roas: number;
  started_at: string;
  finished_at: string;
  issue_state: string;
}

/* ---------------- 로그인 · 토큰 ---------------- */

interface TokenFile {
  /** 로그인 방식 + 이메일 — .env 계정이 바뀌면 토큰을 버림 */
  account?: string;
  access?: string;
  refresh?: string;
  fetchedAt?: number;
  loginFail?: { at: number; cred: string; message: string };
}

export interface AblyClient {
  get<T>(path: string, params?: Record<string, string | number | string[]>): Promise<T>;
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${ABLY_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, status: r.status, json };
}

const tokenOf = (j: Record<string, unknown>) => (j.access_token ?? j.token) as string | undefined;

/** opts.envSuffix: 마켓 계정 — ABLY_EMAIL{envSuffix} · ABLY_PASSWORD{envSuffix} (src/ably-brands.ts). tokenFile 은 시험용 */
export async function ablyLogin(opts: { persist?: boolean; envSuffix?: string; tokenFile?: string } = {}): Promise<AblyClient> {
  const persist = opts.persist ?? true;
  const sfx = opts.envSuffix ?? "";
  const file = opts.tokenFile ?? tokenFile(sfx);
  const email = env(`ABLY_EMAIL${sfx}`);
  const password = () => env(`ABLY_PASSWORD${sfx}`);
  const account = sha(`${LOGIN_FIELD}\n${email}`);
  const cred = sha(`${LOGIN_FIELD}\n${email}\n${password()}`);

  let saved: TokenFile = {};
  try {
    saved = JSON.parse(readFileSync(file, "utf8")) as TokenFile;
  } catch {
    /* 처음 */
  }
  const state: TokenFile = saved.account === account ? { ...saved } : { account, loginFail: saved.loginFail };
  const save = () => {
    if (!persist) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* Windows */
    }
  };
  const keep = (j: Record<string, unknown>, access: string) => {
    state.access = access;
    if (typeof j.refresh_token === "string") state.refresh = j.refresh_token;
    state.fetchedAt = Date.now();
    save();
    return access;
  };

  const login = async (): Promise<string> => {
    const f = state.loginFail;
    if (f && f.cred === cred && Date.now() - f.at < LOGIN_BACKOFF_MS) {
      const at = new Date(f.at + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
      throw new Error(`에이블리 로그인을 잠시 쉬는 중 — ${at}(KST) 실패: ${f.message} · .env 의 ABLY_EMAIL${sfx} · ABLY_PASSWORD${sfx} 를 고치면 바로 다시 시도`);
    }
    try {
      const r = await postJson("/seller/login/", { [LOGIN_FIELD]: email, password: password() });
      const access = tokenOf(r.json);
      if (!r.ok || !access) {
        const why = r.json.code === 2 ? `비밀번호 불일치 (${r.json.message ?? "code 2"})` : `HTTP ${r.status} ${String(r.json.message ?? "").slice(0, 80)} (응답 항목: ${Object.keys(r.json).join(", ")})`;
        throw new Error(`에이블리 로그인 실패: ${why}`);
      }
      delete state.loginFail;
      return keep(r.json, access);
    } catch (e) {
      state.loginFail = { at: Date.now(), cred, message: (e as Error).message.slice(0, 160) };
      save();
      throw e;
    }
  };

  /** refresh_token 으로 새 access_token — 안 되면 null (로그인으로) */
  const refresh = async (): Promise<string | null> => {
    const rt = state.refresh;
    const rexp = rt ? jwtExp(rt) : null;
    if (!rt || (rexp != null && rexp - Date.now() < REFRESH_MIN_LEFT_MS)) return null;
    const r = await postJson("/seller/refresh/", { refresh_token: rt }).catch(() => null);
    const access = r && r.ok ? tokenOf(r.json) : undefined;
    if (!access) {
      delete state.refresh;
      return null;
    }
    return keep(r!.json, access);
  };

  // 동시에 여러 요청이 401 을 받아도 새로 받는 건 한 번
  let renewing: Promise<string> | null = null;
  const renew = () => (renewing ??= (async () => (await refresh()) ?? (await login()))().finally(() => (renewing = null)));
  const usable = (t: string | undefined, at: number | undefined): t is string =>
    !!t && tokenUsable({ token: t, userId: "", exp: jwtExp(t), fetchedAt: at ?? 0 });
  let token: Promise<string> | null = null;
  const current = () => (token ??= usable(state.access, state.fetchedAt) ? Promise.resolve(state.access) : renew());

  return {
    async get<T>(path: string, params: Record<string, string | number | string[]> = {}): Promise<T> {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
        else qs.append(k, String(v));
      }
      const url = `${ABLY_API}${path}${qs.toString() ? "?" + qs : ""}`;
      let renewed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const t = await current();
        const r = await fetch(url, { headers: { Authorization: `JWT ${t}`, Accept: "application/json" } });
        if (r.ok) return (await r.json()) as T;
        if (r.status === 401 && !renewed) {
          renewed = true;
          token = renew();
          continue;
        }
        if (r.status >= 500) {
          await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
          continue;
        }
        throw new Error(`GET ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
      }
      throw new Error(`GET ${path} → 재시도 초과`);
    },
  };
}

/* ---------------- 받기 ---------------- */

export const ORDER_DELIVERY_TYPES = ["standard", "today", "combine", "reserved"];

/**
 * 결제일(checked_at) start ~ end ("YYYY-MM-DD HH:mm:ss", KST) 주문상품 전부 — per_page 100 으로 넘기고 total-count 와 건수를 맞춘다.
 * 받는 동안 새 주문이 들어와 페이지가 밀릴 수 있어 sno 로 겹친 것은 뺀다.
 */
export async function fetchOrders(c: AblyClient, start: string, end: string): Promise<AblyOrderItem[]> {
  const params = { "delivery_type[]": ORDER_DELIVERY_TYPES, start_date: start, end_date: end, date_type: "checked_at" };
  const bySno = new Map<number, AblyOrderItem>();
  for (let page = 1; page <= 200; page++) {
    const j = await c.get<{ order_items: Record<string, unknown>[] }>("/seller/order_items/", { order: "-checked_at", page, per_page: 100, ...params });
    const items = j.order_items ?? [];
    for (const raw of items) {
      const o = pickOrderItem(raw);
      bySno.set(o.sno, o);
    }
    if (items.length < 100) break;
    if (page === 200) throw new Error("에이블리 주문이 20,000건을 넘어요 — 기간을 확인하세요");
  }
  const { total_count } = await c.get<{ total_count: number }>("/seller/order_items/total-count/", params);
  // 세는 사이 들어온 주문만큼은 total-count 가 더 클 수 있음 — 받은 게 더 적으면 빠진 페이지가 있는 것
  if (typeof total_count === "number" && bySno.size < total_count) {
    throw new Error(`에이블리 주문 건수가 안 맞아요 — 받은 ${bySno.size}건 · total-count ${total_count}건 (${start} ~ ${end})`);
  }
  return [...bySno.values()];
}

/** 정산 내역 — 날짜는 월(YYYY-MM)만 (일자면 500) */
export async function fetchFeeHistories(c: AblyClient, startMonth: string, endMonth: string): Promise<SettlementHistory[]> {
  const j = await c.get<{ balance_accounts_histories: SettlementHistory[] }>("/seller/balance_accounts/histories/", {
    start_date: startMonth,
    end_date: endMonth,
  });
  return j.balance_accounts_histories ?? [];
}

/** 광고비 일별 (from ~ to, YYYY-MM-DD) */
export async function fetchAdRows(c: AblyClient, marketSno: string, from: string, to: string): Promise<AblyAdRow[]> {
  const rows = await c.get<AblyAdRow[]>(`/seller/ad_markets/${marketSno}/statistics_timeseries/`, { start_at: from, end_at: to, periodicity: "daily" });
  return (rows ?? []).map((r) => ({ datetime: String(r.datetime), charge: r.charge || 0, order_price: r.order_price || 0 }));
}

/** 기획전 목록 (신청 기간 중 · 아닌 것 모두) — 못 받으면 빈 목록 (보고서의 곁가지) */
export async function fetchEventList(c: AblyClient): Promise<AblyEvent[]> {
  const seen = new Map<number, AblyEvent>();
  for (const isApplyPeriod of ["true", "false"]) {
    for (let page = 1; page <= 10; page++) {
      const j = await c
        .get<{ event_application_list: AblyEvent[]; max_page_number?: number }>("/seller/event-applications/", { page, per_page: 50, is_apply_period: isApplyPeriod })
        .catch(() => ({ event_application_list: [] as AblyEvent[], max_page_number: 0 }));
      (j.event_application_list ?? []).forEach((e) => seen.set(e.sno, e));
      if (!j.max_page_number || page >= j.max_page_number) break;
    }
  }
  return [...seen.values()];
}

/** 쿠폰 목록 — 못 받으면 빈 목록 */
export async function fetchCouponList(c: AblyClient): Promise<AblyCoupon[]> {
  const j = await c.get<{ coupons: AblyCoupon[] }>("/seller/coupons/", { page: 1, per_page: 100 }).catch(() => ({ coupons: [] as AblyCoupon[] }));
  return j.coupons ?? [];
}
