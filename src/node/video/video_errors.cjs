'use strict';

const EXIT_CODES = {
  ok: 0,
  generic: 1,
  preflight: 2,
  ui: 3,
  quota: 4,
  policy: 5,
  timeout: 6,
  missingAsset: 7,
};

const BLOCKER_PATTERNS = [
  {
    category: 'quota',
    state: 'blocked_quota',
    exitCode: EXIT_CODES.quota,
    reason: 'credit or quota exhausted',
    patterns: [
      /\bcredits?\b.{0,80}\b(exhausted|used up|not enough|insufficient|remaining|limit|reached)\b/i,
      /\b(quota|usage limit|daily limit|rate limit)\b.{0,80}\b(exceeded|reached|hit|try again|reset)\b/i,
      /\btry again tomorrow\b/i,
      /\btoo many requests\b/i,
    ],
  },
  {
    category: 'subscription',
    state: 'blocked_subscription',
    exitCode: EXIT_CODES.quota,
    reason: 'subscription or account not eligible',
    patterns: [
      /\b(upgrade|subscribe|subscription|plan)\b.{0,80}\b(required|needed|eligible|access|available)\b/i,
      /\bnot available (for|to) (your|this) account\b/i,
      /\bnot eligible\b/i,
      /\bGoogle AI (Ultra|Pro)\b.{0,80}\b(required|upgrade|available)\b/i,
    ],
  },
  {
    category: 'policy',
    state: 'blocked_policy',
    exitCode: EXIT_CODES.policy,
    reason: 'policy or safety block',
    patterns: [
      /\b(safety|policy|policies|guidelines)\b.{0,80}\b(blocked|violat|restricted|cannot|can't|unable)\b/i,
      /\bcan(?:not|'t) generate\b.{0,80}\b(this|that|video|image|content)\b/i,
      /\bremoved for safety\b/i,
    ],
  },
  {
    category: 'failed_tile',
    state: 'failed_ui',
    exitCode: EXIT_CODES.ui,
    reason: 'provider reported failed render tile',
    patterns: [
      /\bfailed\b.{0,60}\b(tile|generation|render|video|clip)\b/i,
      /\b(generation|render|video|clip)\b.{0,60}\bfailed\b/i,
      /\bsomething went wrong\b/i,
    ],
  },
  {
    category: 'login',
    state: 'failed_ui',
    exitCode: EXIT_CODES.preflight,
    reason: 'login or session expired',
    patterns: [
      /\bsign in\b.{0,80}\b(to continue|required|again)\b/i,
      /\bsession\b.{0,60}\b(expired|ended)\b/i,
      /\blogin\b.{0,60}\b(required|again)\b/i,
    ],
  },
];

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function classifyVisibleText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  for (const blocker of BLOCKER_PATTERNS) {
    const matchedPattern = blocker.patterns.find(pattern => pattern.test(normalized));
    if (!matchedPattern) continue;
    return {
      category: blocker.category,
      state: blocker.state,
      exitCode: blocker.exitCode,
      reason: blocker.reason,
      matched: matchedPattern.source,
      textExcerpt: normalized.slice(0, 500),
    };
  }

  return null;
}

async function getVisibleText(page, maxChars = 6000) {
  return page.evaluate((limit) => {
    const bodyText = document.body ? document.body.innerText || '' : '';
    return bodyText.replace(/\s+/g, ' ').trim().slice(0, limit);
  }, maxChars).catch(() => '');
}

async function classifyPage(page) {
  return classifyVisibleText(await getVisibleText(page));
}

module.exports = {
  BLOCKER_PATTERNS,
  EXIT_CODES,
  classifyPage,
  classifyVisibleText,
  getVisibleText,
  normalizeText,
};
