# DC Coins — setup guide

Everything on the code side is done. These are the steps only you can do,
since each one needs your own Google/Firebase/Razorpay login — I can't
create accounts or type credentials in on your behalf.

Nothing here changes anything live until you finish step 7 (paste the
config into `assets/js/dc-auth.js`). Until then the site behaves exactly
as it does today.

## 1. Create a Firebase project
Go to [console.firebase.google.com](https://console.firebase.google.com) →
**Add project** → name it (e.g. "designhaus-ai-lab") → you can skip Google
Analytics, it's not needed.

## 2. Turn on sign-in methods
**Build → Authentication → Get started → Sign-in method** tab, enable:
- **Google**
- **Phone**
- **Email link (passwordless sign-in)** — under the "Email/Password" provider, toggle "Email link" on.

## 3. Create the database
**Build → Firestore Database → Create database** → start in **production
mode** → pick a region close to your users (e.g. `asia-south1` for India).

## 4. Upgrade to the Blaze plan
Cloud Functions (which verify payments before crediting coins) require the
pay-as-you-go **Blaze** plan. Its free quota is generous — at this app's
scale you should stay at $0/month; you only pay for usage beyond the free
tier. This is in **Project settings → Usage and billing → Modify plan**.

## 5. Get your web app config
**Project settings (gear icon) → General → Your apps → Add app → Web**
(the `</>` icon). Name it anything. It'll show you a config object like:

```js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "designhaus-ai-lab.firebaseapp.com",
  projectId: "designhaus-ai-lab",
  storageBucket: "designhaus-ai-lab.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef",
};
```

This is safe to share (it's not a secret — Firestore/Auth rules do the
actual access control), but send it to me and I'll paste it into
`assets/js/dc-auth.js` for you, replacing the `REPLACE_ME` placeholders.

## 6. Get your Razorpay keys
In your existing Razorpay dashboard (the one behind DCR Copilot's
`rzp.io/rzp/DCRCOPILOT` link): **Settings → API Keys → Generate Key**
(if you don't already have live keys). You'll get a **Key ID** (safe to
share) and a **Key Secret** (never share this with me or paste it in
chat — it goes straight into Firebase's secret manager in step 8, from
your own machine).

## 7. Install the Firebase CLI and log in
On your machine (needs [Node.js](https://nodejs.org) installed):
```bash
npm install -g firebase-tools
firebase login
```
This opens a browser window for you to sign in with the Google account
that owns the Firebase project.

## 8. Set the Razorpay secrets and deploy
From inside this repo's `firebase/` folder:
```bash
cd firebase
firebase use --add          # pick the project you created in step 1
firebase functions:secrets:set RAZORPAY_KEY_ID
firebase functions:secrets:set RAZORPAY_KEY_SECRET
firebase deploy --only functions,firestore:rules
```
Each `secrets:set` command prompts you to paste the value — it's stored
encrypted in Google Secret Manager, never in this repo.

## 9. Adjust coin pricing (optional)
Package prices/coin amounts live in two places that need to match:
- `firebase/functions/index.js` → the `PACKAGES` object
- `assets/js/dc-auth.js` → the `COIN_PACKAGES` array

Defaults right now: ₹99 → 100 DC, ₹299 → 350 DC, ₹499 → 650 DC.

## 10. Test it
Once steps 5–8 are done and the config is pasted in, reload the AI Lab
page, sign in, and try a purchase with a
[Razorpay test card](https://razorpay.com/docs/payments/payments/test-card-upi-details/)
before going live with real payments.

---

**What's already true without doing any of this:** the sign-in and Buy
Coins UI is fully built and wired — it just can't reach a real Firebase
project yet, so buttons will show a friendly "not set up yet" message
instead of erroring.
