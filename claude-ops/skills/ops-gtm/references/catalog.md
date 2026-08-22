# Channel / avenue catalog

## Channel / Avenue Catalog

This is the source-of-truth list the planner draws from. Each row: avenue → fit signals → cost profile → **execution path**. The execution path is what makes `/gtm` seamless with `/marketing`: if a `/marketing` sub-command exists for a channel, the plan recommends it by name; otherwise the channel is marked `manual` and the plan includes templated next-actions instead.

### Paid

| Channel                         | Fits                                 | Cost profile        | Execution                                            |
| ------------------------------- | ------------------------------------ | ------------------- | ---------------------------------------------------- |
| Meta Ads (Facebook + Instagram) | B2C, marketplace, broad consumer     | $5–50 CPA typical   | `/marketing ads` · `/marketing meta create-campaign` |
| Google Ads — Search             | High-intent buyers, existing demand  | $1–30 CPC           | `/marketing google-ads`                              |
| Google Ads — Performance Max    | E-comm with catalog                  | Blended CPA         | `/marketing google-ads`                              |
| YouTube Ads                     | Awareness at scale                   | $0.01–0.30 CPV      | `/marketing google-ads` (video campaigns)            |
| LinkedIn Ads                    | B2B, ACV > $10k                      | $8–15 CPC, $50+ CPL | manual — LinkedIn Campaign Manager                   |
| TikTok Ads                      | B2C, < 35 audience, creative-led     | $1–10 CPC           | manual — TikTok Ads Manager                          |
| Reddit / X / Pinterest          | Niche communities                    | Varies              | manual                                               |
| Podcast sponsorships            | Trust-driven, narrow ICP             | $20–50 CPM          | manual — direct sponsor deals                        |
| Affiliate / partner program     | Marketplace, SaaS with referral loop | Rev-share           | manual — Rewardful / PartnerStack                    |

### Unpaid (Organic)

| Channel                                      | Fits                                        | Effort                      | Execution                                        |
| -------------------------------------------- | ------------------------------------------- | --------------------------- | ------------------------------------------------ |
| Programmatic SEO                             | Dev tools, marketplaces, comparison queries | High upfront, compounding   | `/marketing seo` (tracking) + manual content ops |
| Topic-cluster SEO                            | Content-led SaaS, info-intent               | Medium, 3–6mo to signal     | `/marketing seo`                                 |
| Lifecycle email (welcome, nurture, winback)  | Any with email capture                      | Medium, high leverage       | `/marketing email` (Klaviyo flows)               |
| Instagram organic                            | Visual product, lifestyle                   | Medium, daily               | `/marketing instagram`                           |
| X / LinkedIn founder-led                     | B2B, dev tools, thought leadership          | Daily, high-leverage        | manual                                           |
| Community building (Discord / Slack / forum) | Dev tools, B2C with passion                 | High, ongoing               | manual                                           |
| PR / launch pads (Product Hunt, HN, press)   | Any at launch                               | Spiky                       | `/gtm launch` checklist + manual                 |
| Partnerships / integrations                  | SaaS, marketplaces                          | Medium, compounding         | manual                                           |
| Referral program                             | Any with product-led signup                 | Low eng cost, high leverage | manual — plug into lifecycle email               |

### Sales

| Motion                           | Fits                       | Execution                                                        |
| -------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| Outbound (cold email + LinkedIn) | B2B, ACV > $5k             | `/gtm automation` (AI-personalized) + manual sending tool        |
| Inbound (demo form → AE)         | B2B SaaS with pricing page | manual CRM + routing                                             |
| Product-Led Growth (self-serve)  | Dev tools, horizontal SaaS | manual — instrument onboarding; `/marketing email` for lifecycle |
| Channel / partner                | Enterprise, vertical SaaS  | manual — co-selling motion                                       |

### AI Automation

| Recipe                        | What it does                                         | Stack                              | Plugs into                                                  |
| ----------------------------- | ---------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| AI cold-email personalization | LLM generates opener from enrichment data            | Clay / Apollo + Claude             | outbound sales                                              |
| Generative SEO clusters       | LLM drafts topic-cluster outlines from seed keywords | Claude + GSC data                  | `/marketing seo`                                            |
| Lifecycle copy generator      | Auto-draft Klaviyo flow emails per segment           | Claude + Klaviyo data              | `/marketing email`                                          |
| Ad creative variants          | Bulk-generate Meta/Google ad copy A/B sets           | Claude + `/marketing ads` insights | `/marketing meta create-campaign` · `/marketing google-ads` |
| Support deflection            | LLM answers tier-1 tickets from docs                 | Claude + help-center KB            | manual — help desk                                          |
| Lead scoring                  | LLM scores inbound leads on ICP fit                  | Claude + CRM data                  | manual — CRM                                                |
| Content repurposing           | Long-form → tweets, LinkedIn posts, newsletter       | Claude                             | `/marketing instagram` · manual social                      |

---
