/**
 * Flat Data Postprocess Script
 *
 * This script runs after Flat Data fetches the GitHub Search API response.
 * It extracts the essential data and saves it as a daily slice.
 *
 * Source history: this used to read OSSInsight's /v1/trends/repos. That endpoint
 * stopped returning rows on 2026-09-01 — it now answers HTTP 200 with an empty
 * result and a `data_quality` block declaring the metric unavailable, because
 * their capture of GitHub's event firehose fell to ~0.3% of baseline. The
 * ranking was event-derived, so it could not survive that. We now rank by
 * GitHub's own Search API instead, which reads from GitHub's records directly.
 */

import { readJSON, writeJSON } from "https://deno.land/x/flat@0.0.15/mod.ts";

// Get the filename from Flat Data
const filename = Deno.args[0];
const rawData = await readJSON(filename);

// Extract today's date in Taiwan timezone (UTC+8)
function getTaiwanDate(): string {
  const now = new Date();
  // Add 8 hours to UTC to get Taiwan time
  const taiwanTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return taiwanTime.toISOString().split('T')[0];
}

const today = getTaiwanDate();

// GitHub language colors for visual mapping
const languageColors: Record<string, string> = {
  "JavaScript": "#f1e05a",
  "TypeScript": "#3178c6",
  "Python": "#3572A5",
  "Java": "#b07219",
  "Go": "#00ADD8",
  "Rust": "#dea584",
  "C++": "#f34b7d",
  "C": "#555555",
  "Ruby": "#701516",
  "PHP": "#4F5D95",
  "Swift": "#F05138",
  "Kotlin": "#A97BFF",
  "Dart": "#00B4AB",
  "C#": "#178600",
  "Shell": "#89e051",
  "HTML": "#e34c26",
  "CSS": "#563d7c",
  "Vue": "#41b883",
  "Svelte": "#ff3e00",
  "Jupyter Notebook": "#DA5B0B",
};

// Process the trending data
interface SearchRepo {
  full_name: string;
  language: string | null;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  created_at: string;
}

// H01: Detect API rate limiting or error responses. GitHub answers a throttled
// search with 403 + a `message`, so this catches the rate limit too.
if (rawData?.message || rawData?.error) {
  console.error('❌ API error response detected');
  console.error('   Message:', rawData.message || rawData.error);
  Deno.exit(1);
}

const rows: SearchRepo[] = rawData?.items || [];

// Validate API response - fail early if no data
if (!rows || rows.length === 0) {
  console.error('❌ API returned no data or invalid response');
  console.error('   Raw data:', JSON.stringify(rawData).slice(0, 200));
  Deno.exit(1);
}

interface RepoSlice {
  name: string;
  language: string;
  color: string;
  stars: number;
  score: number;
  starsTotal?: number;
}

// Extract top 10 repos and compute daily metrics with field validation.
//
// The previous source needed a second round-trip per repo: its `stars` field
// had gone bad (single digits for repos with tens of thousands) so we re-queried
// GitHub for the real count. The Search API answers from GitHub's own records,
// so `stargazers_count` is already the real figure and that whole enrichment
// step is gone — one request per day instead of eleven.
const topRepos: RepoSlice[] = rows.slice(0, 10).map((repo: SearchRepo) => {
  const name = repo.full_name || 'unknown/repo';
  const stars = Math.max(0, repo.stargazers_count || 0);
  const forks = Math.max(0, repo.forks_count || 0);

  // Community engagement, as forks per thousand stars. This replaces upstream's
  // opaque `total_score`, which has no equivalent here. Starring is one click;
  // forking means someone opened the code — the ratio separates a repo people
  // bookmarked from one they actually worked on.
  //
  // Measured on 2026-09-09: 32, 39, 63, 81, 84, 99, 150, 162, 253, 1289 —
  // nine in the 30-250 band and one outlier. Template and tutorial repos get
  // forked more than they get starred, so the odd four-figure day is the metric
  // working, not breaking. It still pulls the mean (225 here, against a median
  // of 99), which lands inside the 207-1,518 range the old `total_score`
  // occupied, so the tapestry's amplitude scaling stays in familiar territory.
  const score = stars > 0 ? (forks / stars) * 1000 : 0;

  return {
    name,
    language: repo.language || "Unknown",
    color: languageColors[repo.language || ""] || "#8b8b8b",
    stars,
    starsTotal: stars, // Same figure — see the basis note below
    score,
  };
});

// Both star fields carry the repo's lifetime count, so every slice from here on
// lands on the tapestry's `absolute` basis. That is deliberate: weave.js only
// falls back to `totalStars` when a thread bundles slices that lack
// `totalStarsAbsolute`, i.e. slices written before 2026-08-24. Those cannot
// share a bucket with new ones — `day` tier is one slice per thread, the `week`
// tier buckets 7 days while the two eras sit more than a fortnight apart, and
// month buckets key on YYYY-MM. Simulated forward 365 days over the real
// archive: no bucket ever mixes the two scales.
//
// Re-check that if CONFIG.tiers in weave.js ever changes: widen a bucket enough
// to span both eras and the mixed scales would silently flatten the cloth.
//
// The 7-day window also keeps the gap narrow — a day totals ~13,600 stars here
// against the old era's 20-3,511, near enough that even a mix would not wreck
// the scaling. A 30-day window measured ~314,000, two orders out.
const totalStars = topRepos.reduce((sum: number, r: RepoSlice) => sum + r.stars, 0);
const totalStarsAbsolute = totalStars;

// H04: Prevent division by zero
const avgScore = topRepos.length > 0
  ? topRepos.reduce((sum: number, r: RepoSlice) => sum + r.score, 0) / topRepos.length
  : 0;

// Count languages for color distribution
const languageCounts: Record<string, number> = {};
topRepos.forEach((r: RepoSlice) => {
  languageCounts[r.language] = (languageCounts[r.language] || 0) + 1;
});

// Find dominant language
const dominantLanguage = Object.entries(languageCounts)
  .sort((a, b) => b[1] - a[1])[0]?.[0] || "Unknown";

// Create the daily slice
const dailySlice = {
  date: today,
  metrics: {
    totalStars,
    totalStarsAbsolute,
    avgScore: Math.round(avgScore * 100) / 100,
    dominantLanguage,
    dominantColor: languageColors[dominantLanguage] || "#8b8b8b",
    languageDistribution: languageCounts,
  },
  topRepos,
};

// Write to daily archive
const archiveFilename = `data/daily/${today}.json`;

// Ensure directory exists
try {
  await Deno.mkdir("data/daily", { recursive: true });
} catch {
  // Directory might already exist
}

await writeJSON(archiveFilename, dailySlice);

// Also update the latest.json for quick access
await writeJSON("data/latest.json", dailySlice);

console.log(`✨ Processed ${topRepos.length} repos for ${today}`);
console.log(`   Dominant: ${dominantLanguage} (${dailySlice.metrics.dominantColor})`);
console.log(`   Total stars: ${totalStars.toLocaleString()}`);
console.log(`   Avg engagement (forks per 1k stars): ${dailySlice.metrics.avgScore}`);
