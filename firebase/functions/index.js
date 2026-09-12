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

admin.initializeApp();
const db = admin.firestore();

const RAZORPAY_KEY_ID = defineSecret("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");

// Keep this in sync with COIN_PACKAGES in assets/js/dc-auth.js.
// Amounts are in paise (INR × 100) — Razorpay's order amount unit.
const PACKAGES = {
  pack_100: { coins: 100, amountPaise: 9900 },
  pack_350: { coins: 350, amountPaise: 29900 },
  pack_650: { coins: 650, amountPaise: 49900 },
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
