/**
 * Flat Data Postprocess Script
 *
 * This script runs after Flat Data fetches the OSSInsight API response.
 * It extracts the essential data and saves it as a daily slice.
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
interface TrendingRepo {
  repo_id: string;
  repo_name: string;
  primary_language: string | null;
  description: string;
  stars: string;
  forks: string;
  total_score: string;
}

// H01: Detect API rate limiting or error responses
if (rawData?.message || rawData?.error) {
  console.error('❌ API error response detected');
  console.error('   Message:', rawData.message || rawData.error);
  Deno.exit(1);
}

const rows: TrendingRepo[] = rawData?.data?.rows || [];

// Validate API response - fail early if no data
if (!rows || rows.length === 0) {
  console.error('❌ API returned no data or invalid response');
  console.error('   Raw data:', JSON.stringify(rawData).slice(0, 200));
  Deno.exit(1);
}

// Extract top 10 repos and compute daily metrics with field validation
const topRepos = rows.slice(0, 10).map((repo: TrendingRepo) => {
  // Validate required fields
  const name = repo.repo_name || 'unknown/repo';
  const stars = parseInt(repo.stars) || 0;
  const score = parseFloat(repo.total_score) || 0;

  return {
    name,
    language: repo.primary_language || "Unknown",
    color: languageColors[repo.primary_language || ""] || "#8b8b8b",
    stars: Math.max(0, stars), // Upstream's own figure — see starsTotal below
    score: Math.max(0, score), // Ensure non-negative
  };
});

// H05: Upstream's `stars` field went bad — since 2026-05 it reports single
// digits for repos that genuinely have tens of thousands of stars (measured:
// firecrawl/anydoc reported as 2, actually 18,100). Upstream still *picks* the
// right repos, so we keep its selection and fetch the real count ourselves.
//
// Note the two figures mean different things: `stars` was a daily delta,
// `starsTotal` is the repo's lifetime count. Both are recorded so the tapestry
// can tell them apart instead of silently mixing scales.
interface RepoSlice {
  name: string;
  language: string;
  color: string;
  stars: number;
  score: number;
  starsTotal?: number;
}

async function fetchRealStars(name: string, headers: HeadersInit): Promise<number | null> {
  // One retry: the API answers 504 often enough under parallel load
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://api.github.com/repos/${name}`, { headers });
      if (res.ok) {
        const data = await res.json();
        return typeof data.stargazers_count === 'number' ? data.stargazers_count : null;
      }
      if (res.status === 404 || res.status === 403) return null; // Gone or rate-limited: no point retrying
    } catch {
      // Network hiccup — fall through to the retry
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
  }
  return null;
}

const githubToken = Deno.env.get("GITHUB_TOKEN");
const headers: HeadersInit = {
  "Accept": "application/vnd.github+json",
  "User-Agent": "data-tapestry-weaver",
};
if (githubToken) headers["Authorization"] = `Bearer ${githubToken}`;

const enriched: RepoSlice[] = await Promise.all(
  topRepos.map(async (repo: RepoSlice) => {
    const starsTotal = await fetchRealStars(repo.name, headers);
    return starsTotal === null ? repo : { ...repo, starsTotal };
  })
);

const enrichedCount = enriched.filter(r => r.starsTotal !== undefined).length;
console.log(`⭐ Real star counts: ${enrichedCount}/${enriched.length} (token: ${githubToken ? "yes" : "no"})`);

// Compute daily aggregate metrics for the thread
const totalStars = enriched.reduce((sum: number, r: RepoSlice) => sum + r.stars, 0);

// Lifetime star counts, only when we actually resolved every repo — a partial
// sum would understate the day and put a false dip in the cloth.
const totalStarsAbsolute = enrichedCount === enriched.length
  ? enriched.reduce((sum: number, r: RepoSlice) => sum + (r.starsTotal || 0), 0)
  : null;

// H04: Prevent division by zero
const avgScore = enriched.length > 0
  ? enriched.reduce((sum: number, r: RepoSlice) => sum + r.score, 0) / enriched.length
  : 0;

// Count languages for color distribution
const languageCounts: Record<string, number> = {};
enriched.forEach((r: RepoSlice) => {
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
    ...(totalStarsAbsolute !== null ? { totalStarsAbsolute } : {}),
    avgScore: Math.round(avgScore * 100) / 100,
    dominantLanguage,
    dominantColor: languageColors[dominantLanguage] || "#8b8b8b",
    languageDistribution: languageCounts,
  },
  topRepos: enriched,
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

console.log(`✨ Processed ${enriched.length} repos for ${today}`);
console.log(`   Dominant: ${dominantLanguage} (${dailySlice.metrics.dominantColor})`);
console.log(`   Upstream stars: ${totalStars}`);
console.log(`   Real stars: ${totalStarsAbsolute !== null ? totalStarsAbsolute : "unavailable (partial fetch)"}`);
