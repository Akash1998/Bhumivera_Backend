# Bhumivera 20x Upgrade — Creator Promotions (`/promotions`) & Admin Referral Engine (`/admin/dashboard/referral-engine`)

## 1. Executive Architecture Overview

This upgrade delivers a **20x conversion, usability, and operational upgrade** across both `https://www.bhumivera.com/promotions` (Public Creator Partnership Landing Page + Logged-In Co-Creator Desk) and `https://www.bhumivera.com/admin/dashboard/referral-engine` (Admin Referral & Creator Command Center), with full end-to-end integration between `Bhumivera_Frontend` (React 18 + Vite + Tailwind CSS) and `Bhumivera_Backend` (Express 5 + MySQL 2).

### Multi-Panel Architecture Alignment
- **Public Creator & Brand Ambassador Portal (`/promotions` & `/affiliate`)**: Guides visiting creators through Bhumivera's 3-step onboarding workflow (1. Register at `bhumivera.com/promotions` $\rightarrow$ 2. 12–24h human curation review $\rightarrow$ 3. Campaign brief & code activation), interactive order contribution & milestone calculators, and full open-book commission ledger.
- **Website Marketing & Customer CRM Admin Panel (`/admin/dashboard/referral-engine`)**: Houses the 4-Tab Unified Referral & Creator Command Center:
  1. **Influencer & Promoter Program**: Partner curation queue, search/filter/sort, bulk status & rate updates, 1-click personalized creator welcome messages, batch commission payout settlement, and CSV exports.
  2. **Customer Referral Rewards**: Real-time referral queue KPIs, tiered cart-redemption rules, interactive checkout redemption simulator, manual audited referral/goodwill grants, bulk pending approvals, and lost-coupon reissuance.
  3. **Creator Onboarding & Outreach Studio**: Built-in 3-step onboarding message generator for Email, Instagram DM, and WhatsApp outreach.
  4. **Campaign Briefs & Playbooks**: Full CRUD studio for product campaign briefs, talking points, hook angles, and ASCI/FTC disclosure rules.
- **Panel Isolation Preserved**: Orders, shipping labels, RTO returns, and physical stock remain strictly isolated in `/inventorysoftware`, while customer support and platform vault controls remain in `/support` and `/superadminsupport`.

---

## 2. Complete Manifest of Modified, Added, and Deleted Files

### Deleted Files
- **0 files deleted (`None`)** — 100% of existing files in both `Bhumivera_Backend` and `Bhumivera_Frontend` are preserved intact inside the complete ZIP archive.

### Modified Backend Files (`Bhumivera_Backend`)
| File Path | Summary of 20x Upgrades |
| :--- | :--- |
| `migrations/index.js` | Added **Migration v93 (`upgrade 20x creator promotions and referral engine`)**: idempotently adds `preferred_products`, `content_formats`, `monthly_reach_estimate`, `sample_content_url`, `payout_upi_id`, `whatsapp_contact`, `campaign_brief_ack_at`, and `creator_tier_badge` to `affiliate_partners`, and creates the `affiliate_campaign_briefs` table. |
| `models/affiliatePartnerModel.js` | Added `DEFAULT_CAMPAIGN_BRIEFS` (4 flagship Bhumivera product briefs), `bulkUpdatePartners`, `bulkPayCommissions`, `updatePartnerCreatorProfile`, `listCampaignBriefs`, `saveCampaignBrief`, `deleteCampaignBrief`, `getPublicPromotionsShowcase`, and extended optional creator application fields while preserving 100% backward compatibility. |
| `models/referralModel.js` | Added `getAdminReferralStats` (comprehensive funnel KPIs, wallet balances, order redemptions, and top referrers leaderboard), `bulkDecideReferralClaims` (batch approve/reject pending referrals), and `issueManualReferralGrant` (audited manual referral/cash wallet credit by customer email). |
| `routes/affiliateRoutes.js` | Added 10 new/enhanced endpoints (`GET /promotions-showcase`, `PATCH /partner/me/profile`, `POST /admin/partners/bulk-update`, `POST /admin/commissions/bulk-payout`, `GET/POST/DELETE /admin/campaign-briefs`, `GET /admin/referrals/stats`, `POST /admin/referrals/bulk-decision`, `POST /admin/referrals/manual-grant`). |
| `test/affiliatePartnerModel.test.js` | Added unit test coverage for `bulkUpdatePartners` and `getPublicPromotionsShowcase` alongside all existing partner model tests. |

### Modified Frontend Files (`Bhumivera_Frontend`)
| File Path | Summary of 20x Upgrades |
| :--- | :--- |
| `src/services/api.js` | Added `getPromotionsShowcase`, `updatePartnerProfile`, `bulkUpdateAdminPartners`, `bulkPayAdminCommissions`, `getAdminCampaignBriefs`, `saveAdminCampaignBrief`, `deleteAdminCampaignBrief`, `getAdminReferralStats`, `bulkDecideAdminReferrals`, and `issueAdminManualReferralGrant` to `affiliate` API service. |
| `src/pages/Promotions.jsx` | Upgraded `/promotions` with: (1) **Live Creator Vanity Code & Link Preview Bar**, (2) **Interactive Order Contribution & Milestone Simulator** (3 sample Bhumivera baskets + 1–35 delivered orders slider showing GST-exclusive revenue, costs, creator share, and ₹500 / ₹1,200 / ₹2,500 milestone unlocks), (3) **4-Stage Co-Creator Progression Roadmap**, (4) **Category-Filterable Product Campaign Brief Cards**, (5) **30-Second Creator Alignment Self-Check**, and (6) **Category-Filterable FAQs**. |
| `src/pages/affiliate/PromoterPortal.jsx` | Upgraded logged-in Creator Desk with: (1) **Live Application Readiness Meter (0–100%)**, (2) **1-Click Partnership Intent Inspiration Chips**, (3) **Optional Product & Format Preferences Drawer**, (4) **3-Step Pending Verification Tracker**, (5) **Product Deep-Link Generator (`?aff=CODE`)**, (6) **Ready-to-Post Social Caption & Story Studio** (Instagram, WhatsApp, YouTube), (7) **Creator UPI Payout & WhatsApp Coordination Form**, and (8) **Ledger Status Filter & CSV Export**. |
| `src/pages/admin/AffiliateProgramManagement.jsx` | Upgraded `/admin/dashboard/referral-engine` top-level hub from a 2-tab switcher into a **4-Tab Command Center**: (1) *Influencer & Promoter Program*, (2) *Customer Referral Rewards*, (3) *Creator Onboarding & Outreach Studio* (3-step onboarding templates + WhatsApp deep-share), and (4) *Campaign Briefs & Playbooks* (full CRUD brief studio). |
| `src/pages/admin/PromoterProgramManagement.jsx` | Upgraded with **Partner Search, Status/Platform Filters, Multi-Criteria Sorting**, **Bulk Partner Selection & Bulk Approve/Pause/Rate Updates**, **1-Click Personalized Creator Welcome Message Copy**, **Extended Creator Profile Badges (UPI, WhatsApp, Preferred Products, Formats)**, **Batch Commission Payout Settlement**, and **Commission Ledger CSV Export**. |
| `src/pages/admin/PromoterAnalyticsDashboard.jsx` | Upgraded with **1-Click CSV Export** of promoter performance analytics and **Quick Preset Ritual Baskets** (*1-SKU Basket*, *2-SKU Ritual Duo*, *3-SKU Full Regimen*) in the Earnings Scenario Calculator. |
| `src/pages/admin/AffiliateManagement.jsx` | Upgraded Customer Referral Engine with **Live Queue Summary KPI Cards**, **Interactive Customer Checkout Redemption Simulator**, **Manual Referral / Goodwill Credit Grant Tool**, **Referral Queue Search & Status Filter**, **1-Click Bulk Approve All Pending Referrals**, and **CSV Export**. |

---

## 3. New & Upgraded API Endpoint Registry (`/api/affiliate`)

| Method | Endpoint | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/affiliate/promotions-showcase` | Public | Returns active creator campaign briefs, milestone definitions, 3-step onboarding timeline, and program economics defaults. |
| `POST` | `/api/affiliate/partner/apply` | User | Submits creator partnership application (supports core 8 fields + optional `preferredProducts`, `contentFormats`, `monthlyReachEstimate`, `sampleContentUrl`, `whatsappContact`). |
| `GET` | `/api/affiliate/partner/me` | User | Returns creator dashboard, summary, paginated open-book commission ledger, and program config. |
| `PATCH` | `/api/affiliate/partner/me/perks` | User | Updates custom vanity promo code (`customCode`). |
| `PATCH` | `/api/affiliate/partner/me/profile` | User | Updates creator UPI payout handle (`payoutUpiId`), campaign WhatsApp (`whatsappContact`), preferred products, and content formats. |
| `POST` | `/api/affiliate/admin/partners/bulk-update` | Admin | Bulk updates status (`approved`, `paused`, `rejected`), customer discount %, and contribution share % across selected promoters. |
| `POST` | `/api/affiliate/admin/commissions/bulk-payout` | Admin | Settles multiple approved commission records in one atomic batch with a transfer reference. |
| `GET` | `/api/affiliate/admin/campaign-briefs` | Admin | Lists all creator campaign briefs for admin management. |
| `POST` | `/api/affiliate/admin/campaign-briefs` | Admin | Creates or updates a creator campaign brief. |
| `DELETE` | `/api/affiliate/admin/campaign-briefs/:id` | Admin | Deletes a creator campaign brief by ID. |
| `GET` | `/api/affiliate/admin/referrals/stats` | Admin | Returns aggregated customer referral funnel stats, wallet balances, order redemptions, and top referrers leaderboard. |
| `POST` | `/api/affiliate/admin/referrals/bulk-decision` | Admin | Bulk approves or rejects up to 100 pending customer referral claims. |
| `POST` | `/api/affiliate/admin/referrals/manual-grant` | Admin | Issues an audited manual referral or spendable wallet credit to a customer by email. |

---

## 4. Deployment & Verification Steps

1. **Extract Archive**: Unzip `bhumivera_complete_20x_upgrade.zip` — it contains the complete `Bhumivera_Backend/` and `Bhumivera_Frontend/` folders with all directory structures preserved.
2. **Backend Deployment (Railway)**:
   - Push `Bhumivera_Backend` to your backend repository. On startup, Migration `v93` (`upgrade 20x creator promotions and referral engine`) runs automatically and idempotently.
   - Run `npm test` to verify all unit tests pass.
3. **Frontend Deployment (Vercel)**:
   - Push `Bhumivera_Frontend` to your frontend repository and run `npm run build`.
   - Visit `https://www.bhumivera.com/promotions` (both signed out and signed in) and `https://www.bhumivera.com/admin/dashboard/referral-engine` to use the new 20x studios.
