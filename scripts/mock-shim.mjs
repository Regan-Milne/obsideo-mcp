// Local stand-in for signup.obsideo.io's BILLING surface, with the exact
// response shapes of obsideo-signup app/billing.py + app/main.py (2026-09-11),
// so the MCP's enabled-path parsing can be proven without flipping the live
// shim's STRIPE_ENABLED flag. Storage calls are NOT mocked (they go to the real
// gateway from the account in OBSIDEO_MCP_HOME).
//
//   node scripts/mock-shim.mjs            -> listens on 127.0.0.1:8765
//   OBSIDEO_SIGNUP_URL=http://127.0.0.1:8765 node scripts/e2e-billing.mjs
//
// MOCK_PAID=1 answers as an account that already has a 2-block plan with a
// pending 3-block offer (the 409 subscription_exists + describePlan branch).
import { createServer } from "node:http";

const PAID = !!process.env.MOCK_PAID;
const PORT = Number(process.env.MOCK_PORT ?? 8765);
const BLOCK_GB = 200.0;
const PRICE = 5.0;

function billingStatus() {
  return PAID
    ? {
        enabled: true, plan: "agent_cloud_memory", blocks: 2, block_gb: BLOCK_GB, block_price_usd: PRICE,
        monthly_usd: 10.0, status: "active", period_end: "2026-10-11T00:00:00Z", cancel_at_period_end: false,
        pending_upgrade: {
          to_blocks: 3, from_blocks: 2, new_quota_gb: 600.0, new_monthly_usd: 15.0,
          agree_url: "http://127.0.0.1:8765/v1/billing/stepup/tok_mock", expires_at: "2026-09-18T00:00:00Z",
        },
        how: {},
      }
    : {
        enabled: true, plan: "free", blocks: 0, block_gb: BLOCK_GB, block_price_usd: PRICE, monthly_usd: 0.0,
        status: null, period_end: null, cancel_at_period_end: false, pending_upgrade: null, how: {},
      };
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) return send(401, { detail: { error: "unauthorized" } });
    const url = req.url.split("?")[0];
    if (req.method === "GET" && url === "/v1/billing") return send(200, billingStatus());
    if (req.method === "GET" && url === "/v1/account/usage") {
      return send(200, {
        account_id: "mock-account", used_bytes: 76, quota_bytes: 12 * 1024 ** 3, quota_gb: 12.0,
        percent_used: 0.0, billing: billingStatus(),
      });
    }
    if (req.method === "POST" && url === "/v1/billing/checkout") {
      const blocks = Number(JSON.parse(body || "{}").blocks ?? 1);
      if (PAID) {
        return send(409, { detail: { error: "subscription_exists", message: "this account already has an active subscription",
          next: 'POST /v1/billing/stepup {"blocks": N} to change size; POST /v1/billing/portal to cancel or change card' } });
      }
      if (!(blocks >= 1 && blocks <= 50)) return send(502, { detail: "Could not start checkout: blocks must be between 1 and 50" });
      return send(200, { ok: true, url: `https://checkout.stripe.com/c/pay/cs_test_mock_${blocks}`,
        blocks, monthly_usd: blocks * PRICE, block_gb: BLOCK_GB });
    }
    if (req.method === "POST" && url === "/v1/billing/portal") {
      if (!PAID) return send(409, { detail: "no Stripe customer on this account yet; complete checkout first" });
      return send(200, { ok: true, url: "https://billing.stripe.com/p/session/test_mock" });
    }
    // Trial claim (app/main.py trial_claim_start / trial_claim_verify shapes).
    if (req.method === "POST" && url === "/v1/trial/claim/start") {
      const { email } = JSON.parse(body || "{}");
      if (email === "taken@example.com") return send(409, { detail: { error: "email_in_use", message: "That address already has an account. Sign in to it with POST /v1/auth/start — this trial cannot be merged into it." } });
      return send(200, { ok: true, email, next: "POST /v1/trial/claim/verify with {email, code}",
        keeps: "Your account id, bucket, keys and everything already uploaded stay exactly as they are. Claiming raises the quota; it does not move your data.",
        quota_after_gb: 12.0 });
    }
    if (req.method === "POST" && url === "/v1/trial/claim/verify") {
      const { email, code } = JSON.parse(body || "{}");
      if (code !== "123456") return send(400, { detail: { error: "otp_error", message: "Wrong code." } });
      return send(200, { ok: true, claimed: true, account_id: "trial-spry-meerkat", email, quota_gb: 12.0,
        credentials_unchanged: true, message: "Claimed. Same account, same bucket, same keys — your data is untouched and the quota is now the full free tier." });
    }
    send(404, { detail: "Not Found" });
  });
});
server.listen(PORT, "127.0.0.1", () => console.log(`mock shim on http://127.0.0.1:${PORT} (${PAID ? "PAID" : "free"})`));
