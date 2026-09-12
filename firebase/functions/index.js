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
const DCR_SKILL_ID = "REPLACE_ME";
const DCR_CHAT_COST = 10; // DC Coins per message
const DCR_MAX_HISTORY = 20; // most recent messages kept, oldest trimmed first

exports.sendDcrChatMessage = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
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
