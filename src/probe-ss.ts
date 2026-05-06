import "dotenv/config";
import bcrypt from "bcryptjs";

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
  const d = (await r.json()) as { access_token: string };
  return d.access_token;
}

async function main(): Promise<void> {
  const t = await token();
  console.log("token OK, length=", t.length);

  // 1) seller info
  const r1 = await fetch(`${BASE}/v1/seller/account`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  console.log("\n--- /v1/seller/account ---");
  console.log("status:", r1.status);
  console.log("body:", (await r1.text()).slice(0, 800));

  // 2) channels
  const r2 = await fetch(`${BASE}/v1/seller/channels`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  console.log("\n--- /v1/seller/channels ---");
  console.log("status:", r2.status);
  console.log("body:", (await r2.text()).slice(0, 800));

  // 3) products search (POST)
  const r3 = await fetch(`${BASE}/v1/products/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ size: 5, page: 1 }),
  });
  console.log("\n--- /v1/products/search ---");
  console.log("status:", r3.status);
  console.log("body:", (await r3.text()).slice(0, 800));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
