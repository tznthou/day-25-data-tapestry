/**
 * The Data Tapestry - SVG Weaving Engine
 *
 * Reads all daily data slices and weaves them into a living SVG tapestry.
 * Recent days get one thread each; older days are woven tighter — grouped
 * into weeks, then months — so the cloth stays readable as history grows.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Escape special characters for SVG/XML to prevent injection
function escapeXml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Configuration
const CONFIG = {
  width: 800,
  padding: 20,
  labelGutter: 46, // Right-hand strip reserved for date labels

  // Time tiers: recent history stays daily, older history is woven tighter.
  // `span` = how many days from today this tier covers.
  tiers: [
    { name: 'day', span: 30, height: 12, bucket: 1 },
    { name: 'week', span: 90, height: 10, bucket: 7 },
    { name: 'month', span: Infinity, height: 8, bucket: 'month' },
  ],

  // Visual ranges — thread properties are scaled relative to the data we
  // actually have, so the tapestry never saturates as GitHub's numbers drift.
  strokeRange: [2.8, 6], // Thinnest / thickest thread
  peakRange: [4, 9], // Number of wave crests across the cloth
  // Wave height as a fraction of the room left in the lane after the stroke.
  // The floor keeps the quietest day a wave, not a straight line.
  amplitudeRange: [0.45, 1],
  pointsPerCycle: 16, // Sampling density — below ~8 the sine folds into sawtooth

  maxDays: 3650, // Read guard: ~10 years of slices
  animationDuration: '8s',
};

// Read all daily data files (most recent first)
function loadDailyData() {
  const dailyDir = 'data/daily';

  if (!existsSync(dailyDir)) {
    mkdirSync(dailyDir, { recursive: true });
    return [];
  }

  const files = readdirSync(dailyDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, CONFIG.maxDays);

  return files
    .map(f => {
      const content = readFileSync(join(dailyDir, f), 'utf-8');
      try {
        return JSON.parse(content);
      } catch {
        console.warn(`⚠️  Skipping malformed slice: ${f}`);
        return null;
      }
    })
    .filter(Boolean);
}

// Merge several daily slices into one thread's worth of data
function mergeSlices(slices) {
  const n = slices.length;

  // Averages, not sums — a week's thread must stay comparable to a day's
  const totalStars = slices.reduce((s, d) => s + Math.max(0, d.metrics?.totalStars || 0), 0) / n;
  const avgScore = slices.reduce((s, d) => s + Math.max(0, d.metrics?.avgScore || 0), 0) / n;

  // Two eras of star data live in this archive: upstream's daily delta (which
  // broke in 2026-05) and the real lifetime counts we started fetching after.
  // They differ by more than an order of magnitude, so a thread commits to one
  // basis and is scaled only against threads on the same basis.
  const abs = slices.filter(d => typeof d.metrics?.totalStarsAbsolute === 'number');
  const onAbsolute = abs.length === n;
  const starMetric = onAbsolute
    ? abs.reduce((s, d) => s + d.metrics.totalStarsAbsolute, 0) / n
    : totalStars;

  const languageDistribution = {};
  for (const d of slices) {
    for (const [lang, count] of Object.entries(d.metrics?.languageDistribution || {})) {
      languageDistribution[lang] = (languageDistribution[lang] || 0) + count;
    }
  }

  const dominantLanguage =
    Object.entries(languageDistribution).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown';

  // Newest slice in the bucket wins for the fallback colour
  const dominantColor =
    slices.find(d => d.metrics?.dominantLanguage === dominantLanguage)?.metrics?.dominantColor ||
    slices[0]?.metrics?.dominantColor ||
    '#8b8b8b';

  return {
    starsBasis: onAbsolute ? 'absolute' : 'upstream',
    metrics: {
      totalStars, starMetric, avgScore,
      dominantLanguage, dominantColor, languageDistribution,
    },
    topRepos: slices.flatMap(d => d.topRepos || []),
  };
}

// Which tier does a slice `age` days old belong to, and where does that tier start?
function tierFor(age) {
  let startAge = 0;
  for (const tier of CONFIG.tiers) {
    if (age < tier.span) return { tier, startAge };
    startAge = tier.span;
  }
  const last = CONFIG.tiers[CONFIG.tiers.length - 1];
  return { tier: last, startAge };
}

// Which bucket within a tier does this slice fall into?
function bucketKey(tier, slice, age, startAge) {
  if (tier.bucket === 1) return slice.date;
  if (tier.bucket === 'month') return slice.date.slice(0, 7);
  return `w${Math.floor((age - startAge) / tier.bucket)}`;
}

// Short, gutter-sized label for a bucket
function labelFor(tier, slices) {
  const newest = slices[0]?.date || '';
  const oldest = slices[slices.length - 1]?.date || newest;

  if (tier.name === 'day') return newest.slice(5); // 12-27
  if (tier.name === 'month') return newest.slice(0, 7); // 2025-12 — keep the year, MM-DD is next door
  return slices.length > 1 ? `${oldest.slice(5)}+` : newest.slice(5); // 12-21+
}

// Collapse the daily slices into threads, tier by tier.
// Age is measured in real days from the newest slice — not by array position —
// so a gap in the data stays a gap instead of silently closing up.
function buildThreads(dailyData) {
  if (dailyData.length === 0) return [];

  const newestTime = Date.parse(dailyData[0].date);
  if (Number.isNaN(newestTime)) {
    console.warn('⚠️  Newest slice has no usable date; falling back to array order');
  }

  const buckets = new Map(); // Insertion order = newest first

  for (const slice of dailyData) {
    const time = Date.parse(slice.date);
    const age = Number.isNaN(time) || Number.isNaN(newestTime)
      ? 0
      : Math.round((newestTime - time) / 86400000);

    const { tier, startAge } = tierFor(age);
    const key = `${tier.name}:${bucketKey(tier, slice, age, startAge)}`;

    if (!buckets.has(key)) buckets.set(key, { tier, slices: [] });
    buckets.get(key).slices.push(slice);
  }

  return [...buckets.values()].map(({ tier, slices }) => ({
    tier,
    label: labelFor(tier, slices),
    days: slices.length,
    dateRange: slices.length > 1
      ? `${slices[slices.length - 1].date} ~ ${slices[0].date}`
      : slices[0].date,
    ...mergeSlices(slices),
  }));
}

// Percentile of a sorted array (linear interpolation)
function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Normalise a metric to 0..1 on a log scale, clamped at the 10th/90th
// percentile. Log, because the upstream numbers have swung by two orders of
// magnitude (thousands of stars a day in January, dozens in August) — on a
// linear scale every recent day would collapse onto the same thinnest thread.
// Percentile clamping stops one freak day from flattening everything else.
function makeNorm(values) {
  const log = v => Math.log1p(Math.max(0, v));
  const sorted = values.map(log).sort((a, b) => a - b);
  const lo = quantile(sorted, 0.1);
  const hi = quantile(sorted, 0.9);
  const span = hi - lo;

  return v => {
    if (span < 1e-9) return 0.5; // All alike — sit in the middle
    return Math.min(1, Math.max(0, (log(v) - lo) / span));
  };
}

// Map a normalised value onto a visual range
function lerp([min, max], t) {
  return min + t * (max - min);
}

// Generate a wave path; sampling density follows the crest count so the sine
// never folds into a sawtooth.
function generateWavePath(y, amplitude, peaks, phase, x0, x1) {
  const segments = Math.max(60, Math.ceil(peaks * CONFIG.pointsPerCycle));
  const points = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = x0 + t * (x1 - x0);
    const wave = Math.sin(t * Math.PI * 2 * peaks + phase) * amplitude;
    points.push(`${x.toFixed(2)},${(y + wave).toFixed(2)}`);
  }

  return `M ${points.join(' L ')}`;
}

// Build one thread's SVG fragments
function generateThread(thread, index, totalThreads, y, scales, x0, x1) {
  const { metrics, topRepos, tier, label, dateRange, days, starsBasis } = thread;
  const { dominantColor, totalStars, starMetric, avgScore, languageDistribution } = metrics;

  const starT = scales.stars(starMetric, starsBasis);
  const strokeWidth = lerp(CONFIG.strokeRange, starT);
  const peaks = lerp(CONFIG.peakRange, starT);

  // Wave height is measured against the room left in the lane, so a heavy
  // thread never has to choose between being thick and being wavy — and crests
  // never reach the neighbouring thread's centre line.
  const lane = Math.max(1, (tier.height - strokeWidth) / 2);
  const amplitude = lane * lerp(CONFIG.amplitudeRange, scales.score(avgScore));

  const phase = index * 0.5; // Offset each thread so the cloth looks woven
  const wavePath = generateWavePath(y, amplitude, peaks, phase, x0, x1);

  const gradientId = `thread-${index}`;

  // Up to three language colours, most common first
  const langColors = Object.entries(languageDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lang]) => topRepos.find(r => r.language === lang)?.color || dominantColor);

  while (langColors.length < 2) langColors.push(dominantColor);

  // Recency lives on the wrapper <g>, because the breathe animation owns the
  // path's own opacity and would otherwise flatten every thread to the same value.
  const recency = 0.35 + (1 - index / Math.max(1, totalThreads)) * 0.65;

  const scope = days > 1 ? ` (${days} 天)` : '';
  const langs = Object.keys(languageDistribution).map(escapeXml).join(', ');
  const starText = starsBasis === 'absolute'
    ? `${Math.round(starMetric).toLocaleString()} stars (repo 累計)`
    : `${Math.round(totalStars).toLocaleString()} stars (當日新增)`;

  return {
    gradient: `
    <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${langColors[0]}" />
      <stop offset="50%" stop-color="${langColors[1] || langColors[0]}" />
      <stop offset="100%" stop-color="${langColors[2] || langColors[0]}" />
    </linearGradient>`,
    path: `
    <g opacity="${recency.toFixed(3)}">
      <path
        d="${wavePath}"
        stroke="url(#${gradientId})"
        stroke-width="${strokeWidth.toFixed(3)}"
        stroke-linecap="round"
        fill="none"
        class="thread"
        style="animation-delay: ${(index * 0.1).toFixed(1)}s"
      >
        <title>${escapeXml(dateRange)}${scope}: ${escapeXml(starText)}, ${langs}</title>
      </path>
    </g>`,
    label,
    y,
    tier,
  };
}

// Generate the complete SVG
function generateTapestry(dailyData) {
  const threads = buildThreads(dailyData);

  const x0 = CONFIG.padding;
  const x1 = CONFIG.width - CONFIG.padding - CONFIG.labelGutter;

  // Scales are built from the whole cloth, so contrast never saturates.
  // Stars are scaled per basis — mixing the two eras on one scale would crush
  // every recent thread onto the thinnest setting.
  const starsByBasis = {};
  for (const t of threads) {
    (starsByBasis[t.starsBasis] ||= []).push(t.metrics.starMetric);
  }
  const starNorms = Object.fromEntries(
    Object.entries(starsByBasis).map(([basis, values]) => [basis, makeNorm(values)])
  );
  const scales = {
    stars: (v, basis) => (starNorms[basis] || (() => 0.5))(v),
    score: makeNorm(threads.map(t => t.metrics.avgScore)),
  };

  // Lay threads out top to bottom, each tier with its own row height
  let y = CONFIG.padding + (threads[0]?.tier.height || 12) / 2;
  const laid = threads.map((thread, i) => {
    const built = generateThread(thread, i, threads.length, y, scales, x0, x1);
    y += thread.tier.height;
    return built;
  });

  // Hug the cloth: the canvas ends just below the last thread, no dead space
  const lastHeight = threads[threads.length - 1]?.tier.height || 12;
  const height = Math.max(Math.round(y - lastHeight / 2 + CONFIG.padding), 100);

  const gradients = laid.map(t => t.gradient).join('\n');
  const paths = laid.map(t => t.path).join('\n');

  // Label the newest thread of each tier, then thin out so labels never collide
  const tierCount = {};
  const labels = laid
    .filter((t, i) => {
      const nth = (tierCount[t.tier.name] = (tierCount[t.tier.name] || 0) + 1);
      if (nth === 1 || i === laid.length - 1) return true; // First of each tier, and the oldest thread
      if (t.tier.name === 'day') return (nth - 1) % 7 === 0;
      if (t.tier.name === 'month') return (nth - 1) % 2 === 0;
      return true; // Weeks are sparse enough to label them all
    })
    .map(t => `<text x="${x1 + 8}" y="${(t.y + 3).toFixed(1)}" class="date-label">${escapeXml(t.label)}</text>`)
    .join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CONFIG.width} ${height}" width="${CONFIG.width}" height="${height}">
  <title>The Data Tapestry - GitHub Trends Woven in Time</title>
  <desc>A living data art piece that weaves daily GitHub trending repositories into an evolving tapestry. Recent days are woven one thread per day; older days are gathered into weeks and months.</desc>

  <style>
    .thread {
      animation: breathe ${CONFIG.animationDuration} ease-in-out infinite alternate;
    }

    @keyframes breathe {
      0% {
        opacity: 0.82;
      }
      100% {
        opacity: 1;
      }
    }

    .date-label {
      font-family: ui-monospace, monospace;
      font-size: 8px;
      fill: #999;
    }

    .empty-state {
      font-family: system-ui, sans-serif;
      font-size: 12px;
      fill: #999;
      text-anchor: middle;
    }
  </style>

  <defs>
    ${gradients}

    <!-- Background pattern -->
    <pattern id="loom" patternUnits="userSpaceOnUse" width="20" height="20">
      <rect width="20" height="20" fill="#fafafa"/>
      <circle cx="10" cy="10" r="0.5" fill="#eee"/>
    </pattern>
  </defs>

  <!-- Background -->
  <rect width="100%" height="100%" fill="url(#loom)"/>

  <!-- Threads -->
  <g id="tapestry">
    ${threads.length > 0 ? paths : `
    <text x="${CONFIG.width / 2}" y="70" class="empty-state">
      The loom awaits its first thread...
    </text>
    <text x="${CONFIG.width / 2}" y="90" class="empty-state">
      Check back tomorrow to see the tapestry begin.
    </text>
    `}
  </g>

  <!-- Date markers -->
  <g id="dates">
    ${labels}
  </g>

</svg>`;

  return { svg, threads, height };
}

// Generate Top 10 markdown table
function generateTop10Markdown(latestData) {
  if (!latestData || !latestData.topRepos) {
    return '*No data yet. Check back tomorrow!*';
  }

  const { date, metrics, topRepos } = latestData;
  const rows = topRepos.slice(0, 5).map((repo, i) => {
    const langBadge = `![${repo.language}](https://img.shields.io/badge/-${encodeURIComponent(repo.language)}-${repo.color.slice(1)}?style=flat-square)`;
    return `| ${i + 1} | [${repo.name}](https://github.com/${repo.name}) | ${langBadge} | ⭐ ${repo.stars.toLocaleString()} |`;
  });

  return `**${date}** • ${metrics.dominantLanguage} 主導 • 共 ${metrics.totalStars.toLocaleString()} ⭐

| # | Repository | Language | Stars |
|---|------------|----------|-------|
${rows.join('\n')}`;
}

// Update README with Top 10
// M05: Returns success status for workflow error handling
function updateReadme(latestData) {
  const readmePath = 'README.md';

  if (!existsSync(readmePath)) {
    console.error('❌ README.md not found');
    return false;
  }

  const readme = readFileSync(readmePath, 'utf-8');
  const top10Markdown = generateTop10Markdown(latestData);

  const startMarker = '<!-- TOP10_START -->';
  const endMarker = '<!-- TOP10_END -->';

  if (!readme.includes(startMarker) || !readme.includes(endMarker)) {
    console.error('❌ TOP10 markers not found in README.md');
    return false;
  }

  const before = readme.split(startMarker)[0];
  const after = readme.split(endMarker)[1];

  const newReadme = `${before}${startMarker}\n${top10Markdown}\n${endMarker}${after}`;

  try {
    writeFileSync(readmePath, newReadme);
    console.log('📝 README.md updated with Top 10');
    return true;
  } catch (err) {
    console.error('❌ Failed to write README.md:', err.message);
    return false;
  }
}

// Main execution
function main() {
  console.log('🧵 Loading daily data...');
  const dailyData = loadDailyData();

  console.log(`📊 Found ${dailyData.length} days of data`);

  console.log('🎨 Weaving tapestry...');
  const { svg, threads, height } = generateTapestry(dailyData);

  const byTier = threads.reduce((acc, t) => {
    acc[t.tier.name] = (acc[t.tier.name] || 0) + 1;
    return acc;
  }, {});
  const tierSummary = Object.entries(byTier).map(([k, v]) => `${v} ${k}`).join(' + ') || 'none';

  try {
    writeFileSync('tapestry.svg', svg);
    console.log(`✨ Tapestry woven: tapestry.svg (${threads.length} threads = ${tierSummary}, ${CONFIG.width}x${height})`);
  } catch (err) {
    console.error('❌ Failed to write tapestry.svg:', err.message);
    process.exit(1);
  }

  if (dailyData.length > 0) {
    const latest = dailyData[0];
    console.log(`   Latest thread: ${latest.date}`);
    console.log(`   Dominant: ${latest.metrics.dominantLanguage}`);

    // M05: Update README with Top 10, exit on failure
    const readmeSuccess = updateReadme(latest);
    if (!readmeSuccess) {
      console.error('❌ README update failed, workflow will fail');
      process.exit(1);
    }
  } else {
    console.log('   (Empty tapestry - awaiting first data)');
  }
}

main();
