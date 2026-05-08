import "dotenv/config";
import bcrypt from "bcryptjs";

const cid = process.env.NAVER_CLIENT_ID_PP;
const cs = process.env.NAVER_CLIENT_SECRET_PP;
const ts = Date.now();
const sig = Buffer.from(bcrypt.hashSync(`${cid}_${ts}`, cs), "utf-8").toString("base64");
const r1 = await fetch("https://api.commerce.naver.com/external/v1/oauth2/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: cid, timestamp: String(ts), client_secret_sign: sig, grant_type: "client_credentials", type: "SELF" }),
});
const token = (await r1.json()).access_token;
console.log("token:", token ? "OK" : "FAIL");

const r2 = await fetch("https://api.commerce.naver.com/external/v1/products/search", {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ size: 5, page: 1 }),
});
console.log("\nproducts/search status:", r2.status);
const d2 = await r2.json();
console.log("totalElements:", d2.totalElements, "/ contents:", (d2.contents ?? []).length);
if (!d2.contents) console.log("body:", JSON.stringify(d2).slice(0, 300));
