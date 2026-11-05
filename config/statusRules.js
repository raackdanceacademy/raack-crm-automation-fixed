// config/statusRules.js

const STATUS_RULES = [
  {
    status: 'Resolved',
    keywords: ['rectified', 'solved', 'solve', 'resolved', 'now its working', 'completed'],
  },
  {
    status: 'Fixed',
    keywords: ['fixed', 'done'],
  },
  {
    status: 'Re-Test',
    keywords: ['retest', 're-test', 'test again', 'please test'],
  },
  {
    status: 'Assigned',
    keywords: ['sent to backend team', 'sent to backend', 'backend team', 'assigned'],
  },
  {
    status: 'Open',
    keywords: ['open', 'in progress', 'working on it', 'checking'],
  },
  {
    status: 'New',
    keywords: ['new issue', 'created', 'new'],
  },
];

function detectStatusUpdate(text) {
  if (!text) return null;

  const cleaned = text.toLowerCase().trim();

  for (const rule of STATUS_RULES) {
    if (rule.keywords.some((kw) => cleaned.includes(kw))) {
      return rule.status;
    }
  }

  return null;
}

export { STATUS_RULES, detectStatusUpdate };