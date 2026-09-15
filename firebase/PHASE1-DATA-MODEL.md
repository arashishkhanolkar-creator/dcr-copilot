# AI Lab Subscription — Data Model & Access Control (Phase 1 architecture)

Status: **draft, awaiting sign-off** — nothing here is built yet. This adapts the
brief's schema (written for a relational DB) to Firestore, since we're
extending the existing Firebase setup rather than migrating to Postgres.

---

## 1. Where this differs from the brief — please confirm

The brief's schema is relational (tables + foreign keys). Firestore is a
document store, so a few things are reshaped. These are the decisions that
actually need your sign-off before I write any code:

1. **Private per-user data lives in subcollections under the user**, not a
   flat top-level collection with a `user_id` column — e.g.
   `users/{uid}/projects/{projectId}` instead of a `projects` table. This
   makes the security rule trivial ("you can only read/write your own
   subtree") and avoids needing indexed queries filtered by owner.
2. **Shareable links (Presentation Builder, Practice's Material Library
   client-share) live in their own top-level collections**, keyed by the
   share token itself — e.g. `presentations/{shareToken}`. This is so an
   anonymous client (no login, per the brief) can fetch *that one document*
   by ID, without Firestore rules having to expose anything else.
3. **Confirmed:** Feasibility Studio's report is modeled as fields on the
   project document itself (one report per project, regenerated in
   place) — not a separate historical `feasibility_reports` table.
4. **Trial expiry and grace-period expiry need a scheduled (cron) function**
   — these are time-based transitions ("7 days have passed," "3 days of
   grace have passed"), not triggered by a Razorpay webhook event. This
   wasn't explicitly called out in the brief's build list; flagging it as
   a real infra piece Phase 1 needs.
5. **Every paid/compute action re-checks access server-side**, never trusts
   the client's own gating. The client hides/disables UI for a locked
   product (good UX), but e.g. Feasibility Studio's report-generation
   function independently verifies the caller's subscription status before
   spending a Claude API call — same lesson as the DC Coins deduction
   logic earlier. Non-negotiable, just flagging it explicitly.
6. **The existing `coins` field on user docs stays, unused.** No migration
   needed — DCR Copilot's coin chat is already disabled, so old balances
   just become inert data. Say the word if you'd rather I strip it out.

---

## 2. Firestore schema

### `users/{uid}` (existing collection, new fields added)

| Field | Type | Notes |
|---|---|---|
| `displayName`, `email`, `phone` | string | already exist |
| `coins` | number | legacy, unused going forward (see §1.6) |
| `tier` | `"designer"` \| `"practice"` \| `null` | null before first signup choice |
| `status` | string enum | see §3 — the 7 stored states (no_account = doc doesn't exist / tier is null) |
| `trialStart`, `trialEnd` | timestamp | set at tier selection; `trialEnd = trialStart + 7d` |
| `subscriptionId` | string | Razorpay `sub_...` id, once one exists |
| `razorpaySubscriptionStatus` | string | mirrors Razorpay's own status verbatim, for debugging — separate from our derived `status` |
| `billingPeriod` | `"monthly"` \| `"annual"` | |
| `currentPeriodEnd` | timestamp | from Razorpay subscription object |
| `launchPricing` | boolean | true if they signed up during the launch window |
| `launchPricingExpiry` | timestamp | `signup date + 6 months` — when they roll to regular pricing |
| `gracePeriodEnd` | timestamp | only set while `status = subscription_lapsed` |
| `feasibilityUsageDate` | string `"YYYY-MM-DD"` (IST) | today's date, per the last message sent |
| `feasibilityUsageCount` | number | messages sent today; resets when `feasibilityUsageDate` rolls over — cost guardrail, cap is `FEASIBILITY_DAILY_MESSAGE_CAP` (40) in `functions/index.js` |

### `users/{uid}/projects/{projectId}` — Feasibility Studio, Practice only

`name`, `location`, `zone`, `plotArea`, `landUse`, `existingStructure`,
`developmentIntent`, `regulationSet` (`"udcpr"` \| `"dcpr-2034"`, auto-routed
from location), `createdAt`, `lastActiveAt`, `archived` (boolean, owner-toggled
from the project list's kebab menu — archived projects move to the collapsed
"Archived" section instead of being deleted), plus (pending §1.3):

- `report` (object: the structured feasibility data) + `reportPdfAssetId`
  (points to a stored PDF) + `reportGeneratedAt` — if latest-only, **or**
- `users/{uid}/projects/{projectId}/reports/{reportId}` subcollection — if
  keeping history

### `users/{uid}/projects/{projectId}/conversation/main` — one doc per project

`messages` (array, same shape as DCR Copilot's chat history), `updatedAt`.
Every message in here is answered with the project's site data injected as
context (per the brief's "never allow generic lookup" requirement) —
enforced server-side in the Cloud Function, not by trusting client-sent
context.

### `users/{uid}/projects/{projectId}/files/{fileId}` — uploaded site documents

`name`, `contentType`, `size`, `storagePath`, `downloadURL`, `uploadedAt`,
`analyzed` (boolean, absent until the Cloud Function has actually read it).
Images and PDFs get sent to Claude as content blocks the first time
`sendFeasibilityMessage` runs after upload; DXF gets parsed server-side
instead (`summarizeDxfForFeasibility` in functions/index.js — shoelace-
formula area, segment lengths, and every text label, since DXF isn't a
format Claude can read as an image/PDF) and its text summary sent as a
text block. Either way the file is then flagged `analyzed: true` so the
raw bytes/summary aren't re-sent on every later turn — whatever Claude
extracts persists only as plain text in `conversation/main`, never as file
content in Firestore. Anything else (not image/PDF/DXF) can't be read this
way and is just mentioned by name in the system context.

### `users/{uid}/palettes/{paletteId}` — Material Library, both tiers

`name`, `materials` (array), `createdAt`.

### `palette_shares/{shareToken}` — top-level, Practice only

`ownerId`, `paletteId`, `materialsSnapshot` (array, copied at share-time so
edits to the live palette don't retroactively change what a client already
opened), `createdAt`.

### `presentations` — Presentation Builder, both tiers

- `users/{uid}/presentations/{presentationId}` — the designer's own private
  copy: `projectName`, `images`, `materials`, `notes`, `shareToken`,
  `createdAt`.
- `presentations/{shareToken}` — top-level, public-readable-by-ID mirror of
  the same content, for the client-facing link.

---

## 3. Access states (stored in `users/{uid}.status`)

Matches the brief's 8 states; `no_account` isn't stored (it's just "no user
doc, or `tier` is null").

| Status | Meaning | Set by |
|---|---|---|
| `trial_active` | within 7-day trial | tier selection at signup |
| `trial_expired` | trial ended, never subscribed | scheduled function, `trialEnd < now` |
| `subscribed_designer` / `subscribed_practice` | active paid subscription | webhook: `subscription.activated` / `subscription.charged` (first charge) |
| `subscription_lapsed` | payment failed, in 3-day grace | webhook: `payment.failed` |
| `subscription_cancelled` | cancelled, access continues to period end | webhook: `subscription.cancelled` |
| `subscription_expired` | grace or cancellation period ended, or trial never converted | scheduled function |

**Access matrix** — unchanged from the brief, reproduced here for reference:

| State | Floor Plan / Kitchen Vis / Material Lib / Presentation | Feasibility Studio |
|---|---|---|
| `trial_active` (Designer) | ✓ | Locked |
| `trial_active` (Practice) | ✓ | ✓ |
| `trial_expired` | Locked | Locked |
| `subscribed_designer` | ✓ | Locked |
| `subscribed_practice` | ✓ | ✓ |
| `subscription_lapsed` | ✓ (grace) | ✓ (grace) |
| `subscription_cancelled` | ✓ until `currentPeriodEnd` | per tier, until `currentPeriodEnd` |
| `subscription_expired` | Locked | Locked |

---

## 4. Status

All open questions resolved — this doc is confirmed. Build order (per the
brief): Razorpay plans (done) → auth/tier-selection signup flow + trial
logic (in progress) → webhook handler → access-control middleware.
