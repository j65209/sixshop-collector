/**
 * 식스샵 프로 상점별 주문 — 맥미니 실시간 수집기(src/home-live.ts)용, 브라우저 없이 HTTP 로.
 *
 * 상점에 Access Key(공식 Open API, env SIXSHOP_PRO_ACCESS_KEY{credEnvSuffix})가 있으면 그것만 쓴다 — 로그인 없음 · 만료 없음.
 *   맥미니 실시간 매출(pro-sales) 프록시와 같은 방식 (2026-09 로그인 rate limit 사고 뒤 옮김). 2026-10-28 현재 6개 상점 모두 키가 있다.
 *   소유자 계정이 "통합 계정"이라 /account/sign-in 이 "not found store"(SM-LOGIN-009 · US-IVP-003, HTTP 500)로 거절해서 키 방식으로 바꿈.
 * 키가 없는 상점만 아래 관리자 로그인을 쓴다.
 *
 * 관리자 앱(store.sixshop.com, Next.js "store-manager") 코드와 2026-10-28 로그인된 화면에서 확인한 것 (값은 안 보고 비교만):
 *   1. 로그인  POST https://storemanager-be.sixshop.io/v1/api/account/sign-in  {accountId: 이메일, password}  (소유자 로그인)
 *              관리자(직원) 로그인은 POST /v1/api/user/signin {storeName, userId: 이메일, password} — 상점마다
 *      응답 {code, data} — 소유자는 data.selltore 안에 userToken · ownerId(userId) · currentStore · stores
 *   2. 상점 전환 POST /v1/api/owner/auth/store {storeName} (아래 헤더 7개 필요) → data.userToken = 그 상점 토큰
 *      토큰은 JWT · 상점에 묶임(헤더의 상점 이름만 바꾸면 400) · 약 30일. 전환해도 다른 토큰(사람이 쓰는 브라우저 세션)은 그대로 유효.
 *   3. 주문 API 헤더 7개: Authorization: Bearer <토큰> · x-sixshop-metadata-usertoken · ss-user-token = 토큰,
 *      x-sixshop-metadata-storeid · ss-store-id = 상점 이름(coferry …), x-sixshop-metadata-userId · ss-user-id = ownerId
 *
 * 맥미니 상태 폴더의 토큰 파일(권한 600):
 *   - 상점 토큰을 두고 수명이 꽤 남아 있는 동안 다시 로그인하지 않는다 (30분마다 로그인하지 않게). 계정(.env)이 바뀌면 버림.
 *   - 로그인이 실패하면 그 비밀번호로는 6시간 동안 다시 시도하지 않는다 (30분마다 틀린 비밀번호로 로그인하지 않게).
 *     .env 의 비밀번호를 고치면 바로 다시 시도한다.
 *
 * env: SIXSHOP_PRO_ACCESS_KEY_{KOP·APT·…} (상점별, 있으면 이것만) · 키 없는 상점용 SIXSHOP_PRO_EMAIL · SIXSHOP_PRO_PASSWORD
 *      (선택) SIXSHOP_PRO_LOGIN_TYPE(owner 기본 · user) · SIXSHOP_PRO_TOKEN_FILE
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProOrder } from "./home-report-pro.js";
import { fetchProOrders, openApiHeaders, ORDERS_URL, PRO_API, ProAuthError } from "./sixshop-pro-orders.js";

export interface ProSession {
  orders(store: string, fromIso: string, toIso: string): Promise<ProOrder[]>;
}

export interface StoreToken {
  token: string;
  userId: string;
  /** JWT 만료(ms) — 못 읽으면 null */
  exp: number | null;
  fetchedAt: number;
  /** 새로 받은 토큰도 주문 API 가 거절한 시각 — 인증 문제가 아니라고 보고 한동안 다시 받지 않음 */
  refreshFailedAt?: number;
}

interface TokenFile {
  /** 로그인 방식 + 이메일 — .env 계정이 바뀌면 토큰을 버림 */
  account?: string;
  stores?: Record<string, StoreToken>;
  loginFail?: { at: number; cred: string; message: string };
}

const AUTH_API = `${PRO_API}/v1/api`;
const DAY = 24 * 3600_000;
const LOGIN_BACKOFF_MS = 6 * 3600_000;
const UNKNOWN_EXP_KEEP_MS = 7 * DAY;
// 관리자 화면에서 부르는 것과 같게 (서버가 출처를 볼 수도 있어서)
const BROWSER_HEADERS: Record<string, string> = {
  Accept: "application/json",
  Origin: "https://store.sixshop.com",
  Referer: "https://store.sixshop.com/",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

const tokenFile = () => process.env.SIXSHOP_PRO_TOKEN_FILE ?? join(homedir(), "brightbeed-auto", "state", "sixshop-pro-tokens.json");
const loginType = () => ((process.env.SIXSHOP_PRO_LOGIN_TYPE ?? "owner").toLowerCase() === "user" ? "user" : "owner");
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

/** JWT 만료 시각(ms) — 못 읽으면 null */
export function jwtExp(token: string): number | null {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: number };
    return typeof p.exp === "number" ? p.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** 저장해 둔 토큰을 이번에도 쓸지 — 남은 시간이 하루(짧은 토큰이면 수명의 1/4)보다 많을 때. 만료를 모르면 받은 지 7일까지 */
export function tokenUsable(t: StoreToken, now = Date.now()): boolean {
  if (t.exp == null) return now - t.fetchedAt < UNKNOWN_EXP_KEEP_MS;
  return t.exp - now > Math.min(DAY, (t.exp - t.fetchedAt) / 4);
}

export function proHeaders(t: Pick<StoreToken, "token" | "userId">, store: string): Record<string, string> {
  return {
    ...BROWSER_HEADERS,
    Authorization: `Bearer ${t.token}`,
    "x-sixshop-metadata-usertoken": t.token,
    "ss-user-token": t.token,
    "x-sixshop-metadata-storeid": store,
    "ss-store-id": store,
    "x-sixshop-metadata-userId": t.userId,
    "ss-user-id": t.userId,
  };
}

interface Envelope { code?: number | string; data?: unknown; message?: string; errorMessage?: string; error_message?: string }

/** 식스샵 프로 인증 API 호출 — 응답 {code, data} 의 data (code 400 이상이면 실패) */
async function authPost(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const r = await fetch(`${AUTH_API}${path}`, {
    method: "POST",
    headers: { ...BROWSER_HEADERS, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j: Envelope = {};
  try {
    j = JSON.parse(text) as Envelope;
  } catch {
    /* 아래에서 상태 코드로 */
  }
  const data = (j.data ?? {}) as Record<string, unknown>;
  if (!r.ok || Number(j.code) >= 400) {
    const msg = String(data.message ?? data.errorMessage ?? j.errorMessage ?? j.error_message ?? j.message ?? `HTTP ${r.status}`).slice(0, 120);
    throw new Error(`식스샵 프로 ${path} 실패 (${r.status}${j.code != null ? ` · ${j.code}` : ""}): ${msg}`);
  }
  return data;
}

interface LoginUser {
  userToken?: string;
  ownerId?: string | number;
  userId?: string | number;
  currentStore?: { name?: string; storeName?: string } | null;
  stores?: { storeName: string }[];
  storeNames?: { storeName: string }[];
}

export async function proLogin(opts: { persist?: boolean; accessKeys?: Record<string, string | undefined> } = {}): Promise<ProSession> {
  const persist = opts.persist ?? true;
  const accessKeys = opts.accessKeys ?? {};
  const file = tokenFile();
  const type = loginType();
  // 계정은 키 없는 상점이 있을 때만 필요 — 없으면 로그인할 때 알림
  const email = process.env.SIXSHOP_PRO_EMAIL ?? "";
  const account = sha(`${type}\n${email}`);
  const credOf = () => sha(`${type}\n${env("SIXSHOP_PRO_EMAIL")}\n${env("SIXSHOP_PRO_PASSWORD")}`);

  let saved: TokenFile = {};
  try {
    saved = JSON.parse(readFileSync(file, "utf8")) as TokenFile;
  } catch {
    /* 처음 */
  }
  // 계정이 바뀌었거나 예전 형식이면 토큰은 버림 (로그인 실패 기록은 비밀번호 해시로 따로 판단)
  const state: TokenFile = { account, stores: saved.account === account && saved.stores ? saved.stores : {}, loginFail: saved.loginFail };
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

  /** 로그인 — 같은 비밀번호로 최근에 실패했으면 다시 시도하지 않음 */
  const signIn = async <T>(fn: () => Promise<T>): Promise<T> => {
    const cred = credOf();
    const f = state.loginFail;
    if (f && f.cred === cred && Date.now() - f.at < LOGIN_BACKOFF_MS) {
      const at = new Date(f.at + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
      throw new Error(`식스샵 프로 로그인을 잠시 쉬는 중 — ${at}(KST) 실패: ${f.message} · .env 의 SIXSHOP_PRO_EMAIL · PASSWORD 를 고치면 바로 다시 시도`);
    }
    try {
      const out = await fn();
      if (state.loginFail) {
        delete state.loginFail;
        save();
      }
      return out;
    } catch (e) {
      state.loginFail = { at: Date.now(), cred, message: (e as Error).message.slice(0, 160) };
      save();
      throw e;
    }
  };

  // 소유자 로그인 → 계정의 기본 상점 토큰 (상점 전환 요청에 씀) — 이번 실행에서 필요할 때 한 번만
  let main: Promise<{ token: string; userId: string; store: string }> | null = null;
  const owner = () =>
    (main ??= signIn(async () => {
      const d = await authPost("/account/sign-in", { accountId: env("SIXSHOP_PRO_EMAIL"), password: env("SIXSHOP_PRO_PASSWORD") });
      const u = ((d.selltore as LoginUser | undefined) ?? d) as LoginUser;
      const meta = d.meta as { preferredStoreName?: string } | undefined;
      const userId = u.ownerId ?? u.userId;
      const store = u.currentStore?.storeName ?? u.currentStore?.name ?? meta?.preferredStoreName ?? (u.stores ?? u.storeNames)?.[0]?.storeName;
      if (!u.userToken || userId == null || !store) {
        throw new Error(`로그인 응답에 토큰 · 사용자 · 상점이 없어요 (받은 항목: ${Object.keys(u).join(", ")}) — 관리자(직원) 계정이면 SIXSHOP_PRO_LOGIN_TYPE=user`);
      }
      return { token: u.userToken, userId: String(userId), store };
    }));

  /** 그 상점 토큰 새로 받기 — 소유자: 로그인 1번 + 상점 전환 · 관리자(user): 상점마다 로그인 */
  const fetchToken = async (store: string): Promise<StoreToken> => {
    if (type === "user") {
      const d = (await signIn(() => authPost("/user/signin", { storeName: store, userId: env("SIXSHOP_PRO_EMAIL"), password: env("SIXSHOP_PRO_PASSWORD") }))) as LoginUser;
      if (!d.userToken || d.userId == null) throw new Error(`식스샵 프로 관리자 로그인 응답에 토큰이 없어요 (${store})`);
      return { token: d.userToken, userId: String(d.userId), exp: jwtExp(d.userToken), fetchedAt: Date.now() };
    }
    const m = await owner();
    if (m.store === store) return { token: m.token, userId: m.userId, exp: jwtExp(m.token), fetchedAt: Date.now() };
    const d = await authPost("/owner/auth/store", { storeName: store }, proHeaders(m, m.store));
    const token = d.userToken as string | undefined;
    if (!token) throw new Error(`식스샵 프로 상점 전환 응답에 토큰이 없어요 (${store}) — 이 계정에 그 상점이 있는지 확인`);
    return { token, userId: String(d.ownerId ?? m.userId), exp: jwtExp(token), fetchedAt: Date.now() };
  };
  const renew = async (store: string): Promise<StoreToken> => {
    const t = await fetchToken(store);
    state.stores![store] = t;
    save();
    return t;
  };

  return {
    async orders(store, fromIso, toIso) {
      // Access Key 가 있는 상점은 로그인 · 토큰 파일 없이 Open API 로 (키가 안 먹으면 그대로 실패 — 로그인으로 돌아가지 않음)
      const key = accessKeys[store];
      if (key) return fetchProOrders(openApiHeaders(key, store), fromIso, toIso, ORDERS_URL.accessKey);
      const cached = state.stores![store];
      const t = cached && tokenUsable(cached) ? cached : await renew(store);
      try {
        return await fetchProOrders(proHeaders(t, store), fromIso, toIso);
      } catch (e) {
        if (!(e instanceof ProAuthError)) throw e;
        // 방금 받은 토큰이거나, 새 토큰도 거절당한 지 6시간이 안 됐으면 인증 문제가 아님 — 다시 로그인하지 않음
        const recentFail = t.refreshFailedAt != null && Date.now() - t.refreshFailedAt < LOGIN_BACKOFF_MS;
        if (t !== cached || recentFail) throw e;
        const fresh = await renew(store);
        try {
          return await fetchProOrders(proHeaders(fresh, store), fromIso, toIso);
        } catch (e2) {
          if (e2 instanceof ProAuthError) {
            fresh.refreshFailedAt = Date.now();
            save();
          }
          throw e2;
        }
      }
    },
  };
}
