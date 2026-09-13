// One-time setup: creates the 8 Razorpay subscription Plans for
// Designhaus AI Lab — Designer + Practice tiers, monthly + annual
// billing, launch + regular pricing (8 total, since Razorpay plans
// are immutable: you can't change a plan's price later, you migrate
// subscribers onto a new plan instead — hence separate launch/regular
// plan IDs from the start, per the brief).
//
// Run this yourself, from your own machine, with your own Razorpay
// Key Secret — it never passes through chat:
//
//   cd C:\Users\arash\dcr-copilot
//   $env:RAZORPAY_KEY_SECRET = "paste your live Key Secret here"
//   node firebase\scripts\setup-razorpay-plans.js
//
// Prints all 8 plan_ids and writes them to
// firebase/scripts/razorpay-plan-ids.json. Paste that output back so
// the subscription backend (Phase 1) can be wired to the real plan
// IDs instead of placeholders.
//
// Re-running this script creates 8 NEW plans (Razorpay's Plans API
// has no upsert/update) — only run it again if you actually mean to
// create a fresh set.

const fs = require("fs");
const path = require("path");

const RAZORPAY_KEY_ID = "rzp_live_Tb7xT7hX0FupnW"; // not secret — safe to keep inline

// Launch pricing runs for the first 3 months from go-live (2026-09-20),
// i.e. until 2026-12-20. Not used by this script directly — it's the
// date the subscription backend (Phase 1) will use to decide whether a
// new signup gets a *_launch or *_regular plan.
const LAUNCH_PRICING_END_DATE = "2026-12-20";

const PLANS = [
  { key: "designer_monthly_launch", period: "monthly", interval: 1, amountPaise: 24900, name: "Designhaus AI Lab — Designer, Monthly (Launch)" },
  { key: "designer_monthly_regular", period: "monthly", interval: 1, amountPaise: 39900, name: "Designhaus AI Lab — Designer, Monthly" },
  { key: "designer_annual_launch", period: "yearly", interval: 1, amountPaise: 249000, name: "Designhaus AI Lab — Designer, Annual (Launch)" },
  { key: "designer_annual_regular", period: "yearly", interval: 1, amountPaise: 399000, name: "Designhaus AI Lab — Designer, Annual" },
  { key: "practice_monthly_launch", period: "monthly", interval: 1, amountPaise: 74900, name: "Designhaus AI Lab — Practice, Monthly (Launch)" },
  { key: "practice_monthly_regular", period: "monthly", interval: 1, amountPaise: 99900, name: "Designhaus AI Lab — Practice, Monthly" },
  { key: "practice_annual_launch", period: "yearly", interval: 1, amountPaise: 749000, name: "Designhaus AI Lab — Practice, Annual (Launch)" },
  { key: "practice_annual_regular", period: "yearly", interval: 1, amountPaise: 999000, name: "Designhaus AI Lab — Practice, Annual" },
];

async function createPlan(auth, plan) {
  const res = await fetch("https://api.razorpay.com/v1/plans", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      period: plan.period,
      interval: plan.interval,
      item: {
        name: plan.name,
        amount: plan.amountPaise,
        currency: "INR",
        description: plan.name,
      },
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${plan.key} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.id;
}

async function main() {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    console.error("Set RAZORPAY_KEY_SECRET in your environment first (see the comment at the top of this file).");
    process.exit(1);
  }
  const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${secret}`).toString("base64");

  console.log(`Creating ${PLANS.length} Razorpay plans...\n`);
  const results = { launchPricingEndDate: LAUNCH_PRICING_END_DATE, plans: {} };
  for (const plan of PLANS) {
    const id = await createPlan(auth, plan);
    results.plans[plan.key] = id;
    console.log(`${plan.key}: ${id}`);
  }

  const outPath = path.join(__dirname, "razorpay-plan-ids.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nSaved to ${outPath}`);
  console.log("\nPaste this block back so the subscription backend can be wired to these plan IDs:\n");
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
