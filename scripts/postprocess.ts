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

const rows: TrendingRepo[] = rawData?.data?.rows || [];

// Validate API response - fail early if no data
if (!rows || rows.length === 0) {
  console.error('❌ API returned no data or invalid response');
  console.error('   Raw data:', JSON.stringify(rawData).slice(0, 200));
  Deno.exit(1);
}

// Extract top 10 repos and compute daily metrics
const topRepos = rows.slice(0, 10).map((repo: TrendingRepo) => ({
  name: repo.repo_name,
  language: repo.primary_language || "Unknown",
  color: languageColors[repo.primary_language || ""] || "#8b8b8b",
  stars: parseInt(repo.stars) || 0,
  score: parseFloat(repo.total_score) || 0,
}));

// Compute daily aggregate metrics for the thread
const totalStars = topRepos.reduce((sum: number, r: { stars: number }) => sum + r.stars, 0);
const avgScore = topRepos.reduce((sum: number, r: { score: number }) => sum + r.score, 0) / topRepos.length;

// Count languages for color distribution
const languageCounts: Record<string, number> = {};
topRepos.forEach((r: { language: string }) => {
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
console.log(`   Total Stars: ${totalStars}`);
