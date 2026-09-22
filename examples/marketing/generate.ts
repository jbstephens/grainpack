/**
 * Deterministic synthetic marketing dataset with seeded grain traps.
 * Regenerate with: npm run generate:example
 * Same seed -> byte-identical dataset.json.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DatasetFile, Edge, Entity } from '../../src/types.js';

// Seeded PRNG (mulberry32) — no Math.random, ever.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260911);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const entities: Entity[] = [];
const edges: Edge[] = [];
const add = (e: Entity) => entities.push(e);
const link = (type: string, from: string, to: string) => edges.push({ type, from, to });

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const schema = {
  entities: {
    quarter: { label: 'name' },
    campaign: { label: 'name', aliases: ['campaigns', 'initiative', 'program'], summary: ['objective', 'channelMix'] },
    asset: { label: 'name', aliases: ['assets', 'creative', 'content', 'email', 'banner', 'landing page'], summary: ['kind', 'theme'] },
    execution: { label: 'name', aliases: ['executions', 'send', 'sends', 'run', 'launch'], summary: ['channel', 'sentAt'] },
    audience: { label: 'name', aliases: ['audiences', 'segment', 'segments'], summary: ['intent', 'sizeApprox'] },
    metric: {
      label: 'name',
      aliases: ['metrics', 'performance', 'results', 'conversion', 'rate'],
      summary: ['metric', 'value', 'unit'],
      salience: { valueField: 'value', groupBy: 'metric' },
    },
  },
  relationships: {
    in_quarter: { from: 'campaign', to: 'quarter' },
    has_execution: { from: 'campaign', to: 'execution' },
    uses_asset: { from: 'execution', to: 'asset' },
    targets: { from: 'execution', to: 'audience' },
    measured_by: { from: 'execution', to: 'metric' },
  },
} as const;

// ---------------------------------------------------------------------------
// Fixed scaffolding: quarters, audiences
// ---------------------------------------------------------------------------
const QUARTERS = ['Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2026'];
for (const q of QUARTERS) {
  add({ id: qid(q), type: 'quarter', fields: { name: q } });
}
function qid(q: string): string {
  return 'quarter_' + q.toLowerCase().replace(/\s+/g, '_');
}

const AUDIENCES: Array<{ id: string; name: string; intent: string; size: number }> = [
  { id: 'aud_high_intent', name: 'High-Intent Trials', intent: 'high', size: 4200 },
  { id: 'aud_general', name: 'General Newsletter', intent: 'mixed', size: 88000 },
  { id: 'aud_lapsed', name: 'Lapsed Users', intent: 'low', size: 31000 },
  { id: 'aud_enterprise', name: 'Enterprise Prospects', intent: 'evaluating', size: 2600 },
  { id: 'aud_smb', name: 'SMB Prospects', intent: 'mixed', size: 15400 },
  { id: 'aud_developers', name: 'Developer Community', intent: 'curious', size: 22000 },
  { id: 'aud_events', name: 'Past Event Attendees', intent: 'warm', size: 6100 },
  { id: 'aud_freemium', name: 'Freemium Actives', intent: 'warm', size: 47000 },
];
for (const a of AUDIENCES) {
  add({ id: a.id, type: 'audience', fields: { name: a.name, intent: a.intent, sizeApprox: a.size } });
}

// Audience quality drives conversion in this universe — that's trap #1's engine.
const AUDIENCE_CONV_BASE: Record<string, number> = {
  aud_high_intent: 0.13,
  aud_general: 0.038,
  aud_lapsed: 0.018,
  aud_enterprise: 0.05,
  aud_smb: 0.042,
  aud_developers: 0.03,
  aud_events: 0.06,
  aud_freemium: 0.045,
};

// ---------------------------------------------------------------------------
// Helpers to build campaigns / assets / executions / metrics
// ---------------------------------------------------------------------------
let assetSeq = 0;
function addAsset(id: string | null, name: string, kind: string, theme: string, body: string): string {
  const aid = id ?? `a_${String(++assetSeq).padStart(3, '0')}`;
  add({ id: aid, type: 'asset', fields: { name, kind, theme, body } });
  return aid;
}

let execSeq = 0;
let metricSeq = 0;
function addExecution(opts: {
  id?: string;
  name: string;
  campaign: string;
  asset: string;
  audience: string;
  sentAt: string;
  channel?: string;
  conversion: number;
  openRate?: number;
  clickRate?: number;
}): string {
  const eid = opts.id ?? `e_${String(++execSeq).padStart(3, '0')}`;
  add({
    id: eid,
    type: 'execution',
    fields: { name: opts.name, channel: opts.channel ?? 'email', sentAt: opts.sentAt },
  });
  link('has_execution', opts.campaign, eid);
  link('uses_asset', eid, opts.asset);
  link('targets', eid, opts.audience);
  const metrics: Array<[string, number, string]> = [
    ['conversion_rate', opts.conversion, 'rate'],
    ['open_rate', opts.openRate ?? round3(between(0.28, 0.55)), 'rate'],
    ['click_rate', opts.clickRate ?? round3(between(0.02, 0.09)), 'rate'],
  ];
  for (const [metric, value, unit] of metrics) {
    const trap = opts.id !== undefined; // trap executions get readable metric ids
    const mid = trap ? `metric_${metric.split('_')[0]}_${eid}` : `m_${String(++metricSeq).padStart(4, '0')}`;
    add({
      id: mid,
      type: 'metric',
      fields: {
        name: `${titleCase(metric)} — ${opts.name}`,
        metric,
        value,
        unit,
        measuredAt: opts.sentAt,
      },
    });
    link('measured_by', eid, mid);
  }
  return eid;
}

function titleCase(s: string): string {
  return s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

let campSeq = 0;
function addCampaign(id: string | null, name: string, quarter: string, objective: string, channelMix: string): string {
  const cid = id ?? `c_${String(++campSeq).padStart(2, '0')}`;
  add({ id: cid, type: 'campaign', fields: { name, quarter, objective, channelMix } });
  link('in_quarter', cid, qid(quarter));
  return cid;
}

// ---------------------------------------------------------------------------
// TRAP 1 — False attribution: Welcome Email v2's 16% is the audience, not the copy
// ---------------------------------------------------------------------------
const campQ2Onboarding = addCampaign('camp_q2_onboarding', 'Q2 Onboarding', 'Q2 2026', 'activation', 'email');
const campQ3Onboarding = addCampaign('camp_q3_onboarding', 'Q3 Onboarding', 'Q3 2026', 'activation', 'email');

const welcomeV1 = addAsset(
  'asset_welcome_v1',
  'Welcome Email v1',
  'email',
  'onboarding',
  'Welcome aboard! Here is a guided tour of your workspace, three setup steps, and links to our best getting-started guides.'
);
const welcomeV2 = addAsset(
  'asset_welcome_v2',
  'Welcome Email v2',
  'email',
  'onboarding',
  'Shorter copy, single bold call-to-action: "Finish your setup in 4 minutes." Redesigned hero, benefit-first subject line.'
);

addExecution({
  id: 'exec_q3_high_intent',
  name: 'Q3 High-Intent Welcome Send',
  campaign: campQ3Onboarding,
  asset: welcomeV2,
  audience: 'aud_high_intent',
  sentAt: '2026-08-02',
  conversion: 0.16,
  openRate: 0.61,
  clickRate: 0.14,
});
addExecution({
  id: 'exec_q3_broad',
  name: 'Q3 Broad Welcome Send',
  campaign: campQ3Onboarding,
  asset: welcomeV2,
  audience: 'aud_general',
  sentAt: '2026-08-09',
  conversion: 0.04,
  openRate: 0.39,
  clickRate: 0.05,
});
addExecution({
  id: 'exec_q2_reactivation',
  name: 'Q2 Reactivation Welcome Send',
  campaign: campQ2Onboarding,
  asset: welcomeV2,
  audience: 'aud_lapsed',
  sentAt: '2026-05-14',
  conversion: 0.02,
  openRate: 0.24,
  clickRate: 0.02,
});
// Welcome v1: quietly consistent on comparable audiences
addExecution({
  id: 'exec_q2_welcome_v1',
  name: 'Q2 Standard Welcome Send',
  campaign: campQ2Onboarding,
  asset: welcomeV1,
  audience: 'aud_general',
  sentAt: '2026-04-20',
  conversion: 0.055,
  openRate: 0.42,
  clickRate: 0.06,
});
addExecution({
  id: 'exec_q3_welcome_v1',
  name: 'Q3 Standard Welcome Send',
  campaign: campQ3Onboarding,
  asset: welcomeV1,
  audience: 'aud_general',
  sentAt: '2026-07-21',
  conversion: 0.06,
  openRate: 0.44,
  clickRate: 0.065,
});

// ---------------------------------------------------------------------------
// TRAP 2 — Aggregate reversal: Pricing LP B weak on average, best for enterprise
// ---------------------------------------------------------------------------
const campPricing = addCampaign('camp_pricing_refresh', 'Pricing Page Refresh', 'Q3 2026', 'conversion', 'web + email');
const lpA = addAsset('asset_lp_pricing_a', 'Pricing Landing Page A', 'landing page', 'pricing', 'Classic three-tier pricing table with FAQ and social proof band.');
const lpB = addAsset('asset_lp_pricing_b', 'Pricing Landing Page B', 'landing page', 'pricing', 'ROI-calculator-first layout with security/compliance badges and a "talk to sales" rail.');

addExecution({ id: 'exec_lp_b_enterprise', name: 'Pricing B — Enterprise Wave', campaign: campPricing, asset: lpB, audience: 'aud_enterprise', sentAt: '2026-08-15', channel: 'web', conversion: 0.09, openRate: 0.5, clickRate: 0.1 });
addExecution({ id: 'exec_lp_b_smb', name: 'Pricing B — SMB Wave', campaign: campPricing, asset: lpB, audience: 'aud_smb', sentAt: '2026-08-15', channel: 'web', conversion: 0.021, openRate: 0.35, clickRate: 0.04 });
addExecution({ id: 'exec_lp_b_freemium', name: 'Pricing B — Freemium Wave', campaign: campPricing, asset: lpB, audience: 'aud_freemium', sentAt: '2026-08-22', channel: 'web', conversion: 0.019, openRate: 0.33, clickRate: 0.035 });
addExecution({ id: 'exec_lp_a_enterprise', name: 'Pricing A — Enterprise Wave', campaign: campPricing, asset: lpA, audience: 'aud_enterprise', sentAt: '2026-08-15', channel: 'web', conversion: 0.048, openRate: 0.47, clickRate: 0.08 });
addExecution({ id: 'exec_lp_a_smb', name: 'Pricing A — SMB Wave', campaign: campPricing, asset: lpA, audience: 'aud_smb', sentAt: '2026-08-15', channel: 'web', conversion: 0.05, openRate: 0.4, clickRate: 0.07 });
addExecution({ id: 'exec_lp_a_freemium', name: 'Pricing A — Freemium Wave', campaign: campPricing, asset: lpA, audience: 'aud_freemium', sentAt: '2026-08-22', channel: 'web', conversion: 0.046, openRate: 0.38, clickRate: 0.06 });

// ---------------------------------------------------------------------------
// TRAP 3 — Volume mirage: Mega Promo has the most conversions, below-median rate
// ---------------------------------------------------------------------------
const campMegaPromo = addCampaign('camp_q3_mega_promo', 'Q3 Mega Promo', 'Q3 2026', 'acquisition', 'email + paid');
const promoAsset = addAsset('asset_promo_blast', 'Mega Promo Blast', 'email', 'discount', '48-hour flash discount, urgency-driven subject line, sitewide 30% off.');
for (let i = 0; i < 6; i++) {
  const aud = pick(['aud_general', 'aud_freemium', 'aud_developers', 'aud_smb']);
  const eid = addExecution({
    id: `exec_mega_wave_${i + 1}`,
    name: `Mega Promo Wave ${i + 1}`,
    campaign: campMegaPromo,
    asset: promoAsset,
    audience: aud,
    sentAt: `2026-09-${String(3 + i * 2).padStart(2, '0')}`,
    conversion: round3(between(0.022, 0.034)), // big lists, mediocre rate
  });
  // Absolute conversions are large because the lists are large
  const total = Math.floor(between(900, 2200));
  add({
    id: `metric_total_${eid}`,
    type: 'metric',
    fields: { name: `Total Conversions — Mega Promo Wave ${i + 1}`, metric: 'total_conversions', value: total, unit: 'count', measuredAt: `2026-09-${String(4 + i * 2).padStart(2, '0')}` },
  });
  link('measured_by', eid, `metric_total_${eid}`);
}

// ---------------------------------------------------------------------------
// TRAP 4 — Stale winner: Discount Banner 2025's wins predate the March pricing change
// ---------------------------------------------------------------------------
const campEvergreen = addCampaign('camp_evergreen_display', 'Evergreen Display', 'Q1 2026', 'awareness', 'display');
const bannerOld = addAsset('asset_discount_banner_2025', 'Discount Banner 2025', 'banner', 'discount', 'Legacy "was/now" price-anchoring banner built for the 2025 price list.');
const bannerNew = addAsset('asset_value_banner_2026', 'Value Story Banner 2026', 'banner', 'value', 'Post-repricing banner leading with outcomes instead of discounts.');

addExecution({ id: 'exec_banner_old_jan', name: 'Banner 2025 — January Flight', campaign: campEvergreen, asset: bannerOld, audience: 'aud_general', sentAt: '2026-01-15', channel: 'display', conversion: 0.072 });
addExecution({ id: 'exec_banner_old_feb', name: 'Banner 2025 — February Flight', campaign: campEvergreen, asset: bannerOld, audience: 'aud_freemium', sentAt: '2026-02-12', channel: 'display', conversion: 0.068 });
addExecution({ id: 'exec_banner_old_apr', name: 'Banner 2025 — April Flight (post-repricing)', campaign: campEvergreen, asset: bannerOld, audience: 'aud_general', sentAt: '2026-04-10', channel: 'display', conversion: 0.021 });
addExecution({ id: 'exec_banner_new_may', name: 'Value Banner — May Flight', campaign: campEvergreen, asset: bannerNew, audience: 'aud_general', sentAt: '2026-05-08', channel: 'display', conversion: 0.049 });
addExecution({ id: 'exec_banner_new_jun', name: 'Value Banner — June Flight', campaign: campEvergreen, asset: bannerNew, audience: 'aud_freemium', sentAt: '2026-06-11', channel: 'display', conversion: 0.052 });

// ---------------------------------------------------------------------------
// Filler universe: enough interconnected noise to make retrieval meaningful
// ---------------------------------------------------------------------------
const THEMES = ['webinar', 'case study', 'product update', 'field event', 'nurture', 'newsletter', 'launch', 'renewal', 'trial', 'community'];
const OBJECTIVES = ['awareness', 'activation', 'acquisition', 'expansion', 'retention'];
const KINDS = ['email', 'landing page', 'banner', 'social post', 'webinar deck'];
const WORDS = ['Signal', 'Momentum', 'Northstar', 'Catalyst', 'Horizon', 'Beacon', 'Compass', 'Summit', 'Orbit', 'Pulse', 'Relay', 'Anchor', 'Prism', 'Drift', 'Forge'];
const BODIES = [
  'Invitation copy with agenda highlights, speaker bios, and a register CTA. Subject line leans on scarcity ("Only 40 seats"), preview text names the headline speaker. Body walks three agenda blocks with timestamps, then a logistics section covering venue, parking, and livestream fallback, closing with a calendar-attachment CTA and a P.S. promoting the after-hours meetup.',
  'Three-paragraph nurture touch linking a customer story to a feature walkthrough. Opens with the customer’s before/after metric, pivots to the specific workflow that produced it, and closes with an in-app deep link. Sidebar module lists two related help-center articles and a 90-second video. Footer carries the standard preference-center block.',
  'Product announcement with release notes summary and docs links. Hero states the headline capability in one sentence, followed by a three-bullet what’s-new list, a GIF placeholder, migration notes for admins with a deprecation date callout, and a changelog link. Secondary CTA invites feedback via the community forum.',
  'Event follow-up with recording link, slides, and a book-a-demo CTA. Thanks registrants, names the top three questions from Q&A with short written answers, links the full recording gated behind the existing registration, and offers a 1:1 session slot picker. Includes a speaker-quote pull for social sharing.',
  'Win-back message with a usage recap and a limited re-engagement offer. Personalizes with last-active date and the workspace’s top artifact, frames what changed since they left in three bullets, and presents a 30-day extended trial with a hard expiry. Tone is direct, single CTA, minimal imagery for deliverability.',
];
const EXEC_NOTES = [
  'Segmented hold-out of 5% for measurement; send throttled over 4 hours.',
  'Subject line B beat A in the 10% pre-test; winner rolled to the remainder.',
  'Deliverability dip flagged mid-send; Gmail clipping suspected on long variant.',
  'Coordinated with paid social flight; UTM set shared across channels.',
  'Resend-to-unopeners triggered at 48h with alternate subject line.',
  'Suppressed recent purchasers and active support tickets before send.',
];

const fillerAssets: string[] = [];
for (let i = 0; i < 160; i++) {
  fillerAssets.push(
    addAsset(null, `${pick(WORDS)} ${pick(THEMES)} ${pick(KINDS)} #${i + 1}`, pick(KINDS), pick(THEMES), pick(BODIES))
  );
}

for (let i = 0; i < 55; i++) {
  const quarter = pick(QUARTERS);
  const theme = pick(THEMES);
  const cid = addCampaign(null, `${quarter.split(' ')[0]} ${pick(WORDS)} ${titleCase(theme.replace(/ /g, '_'))}`, quarter, pick(OBJECTIVES), pick(['email', 'email + paid', 'web + email', 'display']));
  const execCount = 14 + Math.floor(rand() * 13);
  for (let j = 0; j < execCount; j++) {
    const aud = pick(AUDIENCES).id;
    const base = AUDIENCE_CONV_BASE[aud];
    const eid = addExecution({
      name: `${pick(WORDS)} ${theme} send ${j + 1}`,
      campaign: cid,
      asset: pick(fillerAssets),
      audience: aud,
      sentAt: `2026-${String(1 + Math.floor(rand() * 9)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 27)).padStart(2, '0')}`,
      channel: pick(['email', 'email', 'email', 'web', 'display']),
      conversion: round3(base * between(0.75, 1.3)),
    });
    const exec = entities.find((e) => e.id === eid)!;
    exec.fields.notes = pick(EXEC_NOTES);
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
const dataset: DatasetFile = {
  formatVersion: 1,
  name: 'synthetic-marketing',
  schema: schema as unknown as DatasetFile['schema'],
  entities,
  edges,
};

const outPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../examples/marketing/dataset.json');
await fs.writeFile(outPath, JSON.stringify(dataset, null, 1));
console.log(`wrote ${outPath}: ${entities.length} entities, ${edges.length} edges`);
