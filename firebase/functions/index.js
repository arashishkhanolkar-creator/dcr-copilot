// ══════════════════════════════════════════════════════
// DC Coins — Razorpay order creation + payment verification.
//
// Coins are only ever credited here, server-side, after the
// Razorpay payment signature has been verified against the Key
// Secret. The client can read its own coin balance but Firestore
// rules forbid it from writing that field directly (see
// firebase/firestore.rules) — this is the only path that can
// increase it.
// ══════════════════════════════════════════════════════
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const Anthropic = require("@anthropic-ai/sdk");

admin.initializeApp();
const db = admin.firestore();

const RAZORPAY_KEY_ID = defineSecret("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET"); // force redeploy to pick up latest secret version
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// Keep this in sync with COIN_PACKAGES in assets/js/dc-auth.js.
// Amounts are in paise (INR × 100) — Razorpay's order amount unit.
const PACKAGES = {
  pack_200: { coins: 200, amountPaise: 5000 },
  pack_700: { coins: 700, amountPaise: 15000 },
  pack_1300: { coins: 1300, amountPaise: 25000 },
};

exports.createRazorpayOrder = onCall(
  { secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    const pkg = PACKAGES[request.data && request.data.packageId];
    if (!pkg) throw new HttpsError("invalid-argument", "Unknown coin package.");

    const razorpay = new Razorpay({
      key_id: RAZORPAY_KEY_ID.value(),
      key_secret: RAZORPAY_KEY_SECRET.value(),
    });
    const order = await razorpay.orders.create({
      amount: pkg.amountPaise,
      currency: "INR",
      notes: { uid: request.auth.uid, packageId: request.data.packageId },
    });

    // Record what this order is *supposed* to be worth before the
    // client ever sees a payment result, so verifyRazorpayPayment
    // has a trustworthy source of truth to check against.
    await db.collection("coin_orders").doc(order.id).set({
      uid: request.auth.uid,
      packageId: request.data.packageId,
      coins: pkg.coins,
      amountPaise: pkg.amountPaise,
      status: "created",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      orderId: order.id,
      amount: pkg.amountPaise,
      currency: "INR",
      keyId: RAZORPAY_KEY_ID.value(),
    };
  }
);

exports.verifyRazorpayPayment = onCall(
  { secrets: [RAZORPAY_KEY_SECRET] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    const { orderId, paymentId, signature } = request.data || {};
    if (!orderId || !paymentId || !signature) {
      throw new HttpsError("invalid-argument", "Missing payment details.");
    }

    const orderRef = db.collection("coin_orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) throw new HttpsError("not-found", "Unknown order.");
    const order = orderSnap.data();
    if (order.uid !== request.auth.uid) {
      throw new HttpsError("permission-denied", "That order doesn't belong to you.");
    }
    if (order.status === "paid") {
      return { coins: order.coins, alreadyCredited: true };
    }

    // Razorpay's documented signature check: HMAC-SHA256 of
    // "order_id|payment_id" using the Key Secret must match what
    // Checkout returned. This is what actually proves the payment
    // is real — everything else in the payload is client-supplied.
    const expected = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET.value())
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    if (expected !== signature) {
      throw new HttpsError("permission-denied", "Payment signature did not verify.");
    }

    const userRef = db.collection("users").doc(request.auth.uid);
    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      const currentCoins = userSnap.exists ? (userSnap.data().coins || 0) : 0;
      tx.set(userRef, { coins: currentCoins + order.coins }, { merge: true });
      tx.set(orderRef, {
        status: "paid",
        paymentId,
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    return { coins: order.coins, alreadyCredited: false };
  }
);

// ══════════════════════════════════════════════════════
// DCR Copilot chat — answers Maharashtra UDCPR/DCPR-2034
// questions using the dcr-copilot Agent Skill, paid for in
// DC Coins per message. Coins are deducted before the model
// call and refunded if the call fails, so a failed query
// never costs the user anything.
// ══════════════════════════════════════════════════════

// Set this to the skill_id printed by firebase/scripts/upload-skill.js
// after you upload the dcr-copilot skill via the Skills API.
const DCR_SKILL_ID = "skill_015TttVjDjmjSBWfCd3RV6GY";
const DCR_CHAT_COST = 0; // TEMP: free while testing — set back to 10 before going live
const DCR_MAX_HISTORY = 20; // most recent messages kept, oldest trimmed first

// DCR Copilot (coin-based) is being retired in favor of Feasibility Studio,
// a subscription-gated product. Disabled here rather than removed so the
// skill/deployment stays intact if it's needed for reference during that
// rebuild.
const DCR_CHAT_ENABLED = false;

exports.sendDcrChatMessage = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    if (!DCR_CHAT_ENABLED) {
      throw new HttpsError("failed-precondition", "DCR Copilot is being rebuilt into Feasibility Studio — check back soon.");
    }
    if (DCR_SKILL_ID === "REPLACE_ME") {
      throw new HttpsError("failed-precondition", "DCR Copilot chat isn't set up yet.");
    }

    const rawMessages = Array.isArray(request.data && request.data.messages) ? request.data.messages : null;
    if (!rawMessages || !rawMessages.length) {
      throw new HttpsError("invalid-argument", "No message provided.");
    }
    const last = rawMessages[rawMessages.length - 1];
    if (!last || last.role !== "user" || typeof last.content !== "string" || !last.content.trim()) {
      throw new HttpsError("invalid-argument", "Last message must be a non-empty user message.");
    }
    const messages = rawMessages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-DCR_MAX_HISTORY)
      .map(m => ({ role: m.role, content: m.content }));

    const uid = request.auth.uid;
    const userRef = db.collection("users").doc(uid);

    // Deduct up front so the balance can never go negative under concurrent
    // requests; refunded below if the model call fails.
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const coins = snap.exists ? (snap.data().coins || 0) : 0;
      if (coins < DCR_CHAT_COST) {
        throw new HttpsError("failed-precondition", "Not enough DC Coins — top up to keep asking.");
      }
      tx.set(userRef, { coins: coins - DCR_CHAT_COST }, { merge: true });
    });

    try {
      const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 4096,
        system:
          "You are DCR Copilot, embedded as a chat widget on the Designhaus Collective website " +
          "(designhauscollective.in). You are answering a paying visitor directly in that chat " +
          "widget, not in Claude Code or claude.ai — there is no terminal or file explorer for them " +
          "to see, so never refer to files, the skill, or your own tool use. Just answer as the " +
          "product itself, following the loaded skill's instructions for tone, citations, and scope.",
        container: { skills: [{ type: "custom", skill_id: DCR_SKILL_ID, version: "latest" }] },
        tools: [{ type: "code_execution_20260521", name: "code_execution" }],
        messages,
      });

      const reply = response.content
        .filter(block => block.type === "text")
        .map(block => block.text)
        .join("\n\n")
        .trim();

      if (!reply) {
        throw new Error("Model returned no text content.");
      }

      const finalSnap = await userRef.get();
      return { reply, coins: finalSnap.exists ? (finalSnap.data().coins || 0) : 0 };
    } catch (err) {
      // Refund the charge — a failed query should never cost the user coins.
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const coins = snap.exists ? (snap.data().coins || 0) : 0;
        tx.set(userRef, { coins: coins + DCR_CHAT_COST }, { merge: true });
      });
      if (err instanceof HttpsError) throw err;
      console.error("sendDcrChatMessage failed", err);
      throw new HttpsError("internal", "DCR Copilot couldn't answer that just now — you haven't been charged, try again.");
    }
  }
);

// ══════════════════════════════════════════════════════
// AI Lab subscription — trial activation + expiry.
//
// tier/status/trial* fields are only ever written here (Admin SDK,
// bypasses Firestore rules) or by the Razorpay webhook handler once
// that's built — never by the client directly. See
// firebase/PHASE1-DATA-MODEL.md for the full state machine.
// ══════════════════════════════════════════════════════
const { onSchedule } = require("firebase-functions/v2/scheduler");

const TRIAL_DAYS = 7;

exports.startTrial = onCall(
  {},
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    const tier = request.data && request.data.tier;
    if (tier !== "designer" && tier !== "practice") {
      throw new HttpsError("invalid-argument", "tier must be 'designer' or 'practice'.");
    }

    const userRef = db.collection("users").doc(request.auth.uid);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() : {};
      if (data.tier || data.status) {
        throw new HttpsError("failed-precondition", "You've already started a trial or subscription.");
      }
      const now = admin.firestore.Timestamp.now();
      const trialEnd = admin.firestore.Timestamp.fromMillis(now.toMillis() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
      tx.set(userRef, {
        tier,
        status: "trial_active",
        trialStart: now,
        trialEnd,
      }, { merge: true });
      return { status: "trial_active", tier, trialEndMillis: trialEnd.toMillis() };
    });
  }
);

// Runs hourly: flips any trial past its trialEnd to trial_expired, unless
// they've since subscribed (subscriptionId would be set by the webhook
// handler, which also updates status away from trial_active — this query
// only ever matches users still sitting at trial_active).
exports.expireTrials = onSchedule("every 1 hours", async () => {
  const now = admin.firestore.Timestamp.now();
  const snap = await db.collection("users")
    .where("status", "==", "trial_active")
    .where("trialEnd", "<=", now)
    .get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.forEach(doc => batch.update(doc.ref, { status: "trial_expired" }));
  await batch.commit();
  console.log(`expireTrials: transitioned ${snap.size} user(s) to trial_expired`);
});

// ══════════════════════════════════════════════════════
// Feasibility Studio — the DCR Copilot regulation skill, grounded in a
// specific user-created project's site data instead of answering generic
// lookups. Practice tier only (trial or subscribed). Unlike the retired
// coin-based chat, there's no per-message charge — access is gated by
// subscription status, checked server-side on every call (never trust
// the client's own UI gating).
// ══════════════════════════════════════════════════════
const FEASIBILITY_MAX_HISTORY = 30;

function hasFeasibilityAccess(userData) {
  if (!userData || userData.tier !== "practice") return false;
  return ["trial_active", "subscribed_practice", "subscription_lapsed", "subscription_cancelled"].includes(userData.status);
}

function buildSiteContext(project) {
  const line = (label, value) => `- ${label}: ${value || "not provided yet"}`;
  return [
    `Site details for this project ("${project.name || "Untitled project"}"):`,
    line("Location", project.location),
    line("Zone / ward", project.zone),
    line("Plot area", project.plotArea ? `${project.plotArea} sqm` : null),
    line("Land use", project.landUse),
    line("Existing structure", project.existingStructure),
    line("Development intent", project.developmentIntent),
    "",
    "Ground every answer in this specific site — never fall back to a generic, " +
    "unattributed answer. If a detail you need is missing above and hasn't been " +
    "mentioned in the conversation, ask the user for it rather than guessing.",
  ].join("\n");
}

exports.sendFeasibilityMessage = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    if (DCR_SKILL_ID === "REPLACE_ME") {
      throw new HttpsError("failed-precondition", "Feasibility Studio isn't set up yet.");
    }

    const uid = request.auth.uid;
    const projectId = request.data && request.data.projectId;
    const messageText = request.data && request.data.message;
    if (!projectId || typeof projectId !== "string") {
      throw new HttpsError("invalid-argument", "projectId is required.");
    }
    if (!messageText || typeof messageText !== "string" || !messageText.trim()) {
      throw new HttpsError("invalid-argument", "message must be non-empty.");
    }

    const userSnap = await db.collection("users").doc(uid).get();
    if (!hasFeasibilityAccess(userSnap.exists ? userSnap.data() : null)) {
      throw new HttpsError("permission-denied", "Feasibility Studio is on the Practice plan — subscribe or start a Practice trial to use it.");
    }

    const projectRef = db.collection("users").doc(uid).collection("projects").doc(projectId);
    const projectSnap = await projectRef.get();
    if (!projectSnap.exists) {
      throw new HttpsError("not-found", "Project not found.");
    }
    const project = projectSnap.data();

    const conversationRef = projectRef.collection("conversation").doc("main");
    const conversationSnap = await conversationRef.get();
    const history = (conversationSnap.exists ? conversationSnap.data().messages : []) || [];
    const trimmedHistory = history.slice(-FEASIBILITY_MAX_HISTORY);

    const messages = [...trimmedHistory, { role: "user", content: messageText }]
      .map(m => ({ role: m.role, content: m.content }));

    try {
      const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 4096,
        system:
          "You are Feasibility Studio, part of Designhaus AI Lab, embedded as a chat on a project " +
          "workspace page — not in Claude Code or claude.ai. There is no terminal or file explorer " +
          "visible to the user, so never refer to files, the skill, or your own tool use. Answer as " +
          "the product itself, following the loaded skill's instructions for tone, citations, and scope.\n\n" +
          buildSiteContext(project),
        container: { skills: [{ type: "custom", skill_id: DCR_SKILL_ID, version: "latest" }] },
        tools: [{ type: "code_execution_20260521", name: "code_execution" }],
        messages,
      });

      const reply = response.content
        .filter(block => block.type === "text")
        .map(block => block.text)
        .join("\n\n")
        .trim();
      if (!reply) throw new Error("Model returned no text content.");

      // Not arrayUnion: it dedupes exact-match entries, which would
      // silently drop a message if the user (or the model) repeats
      // itself verbatim — a plain read-append-write is correct here.
      const now = admin.firestore.FieldValue.serverTimestamp();
      await conversationRef.set({
        messages: [...history, { role: "user", content: messageText }, { role: "assistant", content: reply }],
        updatedAt: now,
      }, { merge: true });
      await projectRef.set({ lastActiveAt: now }, { merge: true });

      return { reply };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      console.error("sendFeasibilityMessage failed", err);
      throw new HttpsError("internal", "Feasibility Studio couldn't answer that just now — try again.");
    }
  }
);
