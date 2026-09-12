// ══════════════════════════════════════════════════════
// Designhaus AI Lab — Sign-in + DC Coins
//
// Firebase-backed login (Google / Phone / Email) and a DC Coins
// balance meant to pay for AI Lab products later. Nothing in this
// file gates any product today — signing in just gives you a coin
// balance that can go up (nothing spends it yet).
//
// ── SETUP ──────────────────────────────────────────────
// 1. Create a Firebase project at console.firebase.google.com
//    (free Spark plan to start; Cloud Functions below need Blaze,
//    Firebase's pay-as-you-go plan — its free quota is generous and
//    this app won't come close to it at low volume).
// 2. Authentication → Sign-in method → enable Google, Phone, and
//    Email link (passwordless sign-in).
// 3. Firestore Database → create database (production mode) →
//    deploy the rules in firebase/firestore.rules.
// 4. Project settings → General → Your apps → Add app → Web →
//    copy the config object it gives you into FIREBASE_CONFIG below.
// 5. Deploy firebase/functions (see firebase/SETUP.md) so
//    createRazorpayOrder / verifyRazorpayPayment exist.
// This config object is NOT a secret — it's meant to be public;
// access is controlled by the Firestore/Auth rules, not by hiding it.
// ══════════════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut,
  RecaptchaVerifier, signInWithPhoneNumber,
  isSignInWithEmailLink, sendSignInLinkToEmail, signInWithEmailLink,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getFunctions, httpsCallable,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAKStYBUCvHs_iSDBXuFSe1lapfewdICsc",
  authDomain: "designhaus-ai-lab.firebaseapp.com",
  projectId: "designhaus-ai-lab",
  storageBucket: "designhaus-ai-lab.firebasestorage.app",
  messagingSenderId: "320801112110",
  appId: "1:320801112110:web:5beb9a21b285e9002adfbf",
};
export const DC_FIREBASE_CONFIGURED = FIREBASE_CONFIG.apiKey !== "REPLACE_ME";

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);

// Keep these in sync with firebase/functions/index.js's PACKAGES map.
export const COIN_PACKAGES = [
  { id: "pack_200", coins: 200, priceINR: 50 },
  { id: "pack_700", coins: 700, priceINR: 150, best: true },
  { id: "pack_1300", coins: 1300, priceINR: 250 },
];

// Keep in sync with DCR_CHAT_COST in firebase/functions/index.js.
export const DCR_CHAT_COST = 0; // TEMP: free while testing — set back to 10 before going live

let currentUser = null;
let unsubscribeCoins = null;
const listeners = new Set();
function notify() { listeners.forEach(fn => fn(currentUser)); }

// Subscribe to auth/coin state. Called immediately with the current
// state, then again on every change. Returns an unsubscribe function.
export function onDCAuthChange(fn) {
  listeners.add(fn);
  fn(currentUser);
  return () => listeners.delete(fn);
}

async function ensureUserDoc(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      displayName: user.displayName || "",
      email: user.email || "",
      phone: user.phoneNumber || "",
      coins: 0,
      createdAt: serverTimestamp(),
    });
  }
}

onAuthStateChanged(auth, async (user) => {
  if (unsubscribeCoins) { unsubscribeCoins(); unsubscribeCoins = null; }
  if (user) {
    await ensureUserDoc(user);
    currentUser = {
      uid: user.uid, displayName: user.displayName,
      email: user.email, phoneNumber: user.phoneNumber, coins: 0,
    };
    notify();
    unsubscribeCoins = onSnapshot(doc(db, "users", user.uid), snap => {
      if (snap.exists()) {
        currentUser = { ...currentUser, coins: snap.data().coins || 0 };
        notify();
      }
    });
  } else {
    currentUser = null;
    notify();
  }
});

export function dcSignInWithGoogle() {
  return signInWithPopup(auth, new GoogleAuthProvider());
}
export function dcSignOut() {
  return signOut(auth);
}

// ---- Phone sign-in: call dcStartPhoneSignIn, then dcConfirmPhoneCode
// once the user has the SMS code. ----
let confirmationResult = null;
export function dcStartPhoneSignIn(phoneNumberE164, recaptchaContainerId) {
  const verifier = new RecaptchaVerifier(auth, recaptchaContainerId, { size: "invisible" });
  return signInWithPhoneNumber(auth, phoneNumberE164, verifier).then(res => {
    confirmationResult = res;
  });
}
export function dcConfirmPhoneCode(code) {
  if (!confirmationResult) return Promise.reject(new Error("Start phone sign-in first."));
  return confirmationResult.confirm(code);
}

// ---- Email link (passwordless) sign-in ----
const EMAIL_STORAGE_KEY = "dc_email_for_signin";
export function dcSendEmailLink(email) {
  const actionCodeSettings = {
    url: window.location.href.split("#")[0],
    handleCodeInApp: true,
  };
  return sendSignInLinkToEmail(auth, email, actionCodeSettings).then(() => {
    window.localStorage.setItem(EMAIL_STORAGE_KEY, email);
  });
}
// Call once on page load; resolves true if this load completed an
// email-link sign-in (and cleans the link out of the URL bar).
export function dcCompleteEmailLinkSignInIfPresent() {
  if (!isSignInWithEmailLink(auth, window.location.href)) return Promise.resolve(false);
  let email = window.localStorage.getItem(EMAIL_STORAGE_KEY);
  if (!email) email = window.prompt("Confirm your email to finish signing in:");
  return signInWithEmailLink(auth, email, window.location.href).then(() => {
    window.localStorage.removeItem(EMAIL_STORAGE_KEY);
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  });
}

// ---- DC Coin purchase — Razorpay Checkout, verified server-side
// before any coins are credited (see firebase/functions/index.js). ----
export async function dcBuyCoinPackage(packageId) {
  if (!currentUser) throw new Error("Sign in first.");
  if (typeof Razorpay === "undefined") {
    throw new Error("Payment widget didn't load. Check your connection and try again.");
  }
  const createOrder = httpsCallable(functions, "createRazorpayOrder");
  const { data } = await createOrder({ packageId });
  return new Promise((resolve, reject) => {
    const rzp = new Razorpay({
      key: data.keyId,
      amount: data.amount,
      currency: data.currency,
      order_id: data.orderId,
      name: "Designhaus AI Lab",
      description: "DC Coins top-up",
      prefill: { email: currentUser.email || "", contact: currentUser.phoneNumber || "" },
      theme: { color: "#c1653e" },
      handler: async (response) => {
        try {
          const verify = httpsCallable(functions, "verifyRazorpayPayment");
          const result = await verify({
            orderId: response.razorpay_order_id,
            paymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature,
          });
          resolve(result.data);
        } catch (err) { reject(err); }
      },
      modal: { ondismiss: () => reject(new Error("Payment cancelled")) },
    });
    rzp.open();
  });
}

// ---- DCR Copilot chat — each call sends the running conversation and
// gets back one assistant reply, at a cost of DCR_CHAT_COST DC Coins per
// call (deducted server-side; refunded automatically if the call fails). ----
export async function dcSendChatMessage(messages) {
  if (!currentUser) throw new Error("Sign in first.");
  const send = httpsCallable(functions, "sendDcrChatMessage");
  const { data } = await send({ messages });
  return data;
}
