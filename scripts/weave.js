/**
 * The Data Tapestry - SVG Weaving Engine
 *
 * Reads all daily data slices and weaves them into a living SVG tapestry.
 * Each day becomes a horizontal thread with colors and textures
 * derived from GitHub trending data.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Configuration
const CONFIG = {
  width: 800,
  threadHeight: 12,
  maxThreads: 90, // ~3 months of history
  padding: 20,
  animationDuration: '8s',
};

// Read all daily data files
function loadDailyData() {
  const dailyDir = 'data/daily';

  if (!existsSync(dailyDir)) {
    mkdirSync(dailyDir, { recursive: true });
    return [];
  }

  const files = readdirSync(dailyDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse() // Most recent first
    .slice(0, CONFIG.maxThreads);

  return files.map(f => {
    const content = readFileSync(join(dailyDir, f), 'utf-8');
    return JSON.parse(content);
  });
}

// Generate a wave path for a thread
function generateWavePath(y, metrics, index, width) {
  const { avgScore, totalStars } = metrics;

  // Normalize values for wave generation
  const amplitude = Math.min(avgScore / 500, 1) * 4; // Wave height based on score
  const frequency = Math.max(totalStars / 1000, 0.5); // Wave frequency based on stars
  const phase = index * 0.5; // Phase shift per day

  const points = [];
  const segments = 50;

  for (let i = 0; i <= segments; i++) {
    const x = CONFIG.padding + (i / segments) * (width - CONFIG.padding * 2);
    const wave = Math.sin((i / segments) * Math.PI * frequency * 4 + phase) * amplitude;
    points.push(`${x},${y + wave}`);
  }

  return `M ${points.join(' L ')}`;
}

// Generate thread element
function generateThread(data, index, totalThreads) {
  const y = CONFIG.padding + index * CONFIG.threadHeight;
  const { date, metrics, topRepos } = data;
  const { dominantColor, totalStars, avgScore, languageDistribution } = metrics;

  // Calculate stroke width based on total stars
  const strokeWidth = Math.max(2, Math.min(8, totalStars / 500));

  // Generate wave path
  const wavePath = generateWavePath(y, metrics, index, CONFIG.width);

  // Create gradient ID for this thread
  const gradientId = `thread-${index}`;

  // Get language colors for gradient
  const langColors = Object.entries(languageDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([lang]) => {
      const repo = topRepos.find(r => r.language === lang);
      return repo?.color || dominantColor;
    });

  // Ensure we have at least 2 colors for gradient
  while (langColors.length < 2) {
    langColors.push(dominantColor);
  }

  // Animation delay based on position
  const animDelay = `${index * 0.1}s`;

  // Opacity based on recency (newer = more opaque)
  const opacity = 0.4 + (1 - index / totalThreads) * 0.6;

  return {
    gradient: `
    <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${langColors[0]}" />
      <stop offset="50%" stop-color="${langColors[1] || langColors[0]}" />
      <stop offset="100%" stop-color="${langColors[2] || langColors[0]}" />
    </linearGradient>`,
    path: `
    <path
      d="${wavePath}"
      stroke="url(#${gradientId})"
      stroke-width="${strokeWidth}"
      stroke-linecap="round"
      fill="none"
      opacity="${opacity}"
      class="thread"
      style="animation-delay: ${animDelay}"
    >
      <title>${date}: ${totalStars} stars, ${Object.keys(languageDistribution).join(', ')}</title>
    </path>`,
    date,
  };
}

// Generate the complete SVG
function generateTapestry(dailyData) {
  const height = CONFIG.padding * 2 + dailyData.length * CONFIG.threadHeight;

  // Generate threads
  const threads = dailyData.map((data, i) =>
    generateThread(data, i, dailyData.length)
  );

  // Collect unique gradients
  const gradients = threads.map(t => t.gradient).join('\n');
  const paths = threads.map(t => t.path).join('\n');

  // Date labels (show every 7th day)
  const dateLabels = threads
    .filter((_, i) => i % 7 === 0)
    .map((t, i) => {
      const y = CONFIG.padding + (i * 7) * CONFIG.threadHeight + 4;
      return `<text x="${CONFIG.width - CONFIG.padding + 5}" y="${y}" class="date-label">${t.date.slice(5)}</text>`;
    })
    .join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CONFIG.width} ${Math.max(height, 200)}" width="${CONFIG.width}" height="${Math.max(height, 200)}">
  <title>The Data Tapestry - GitHub Trends Woven in Time</title>
  <desc>A living data art piece that weaves daily GitHub trending repositories into an evolving tapestry. Each thread represents one day of open source activity.</desc>

  <style>
    .thread {
      animation: breathe ${CONFIG.animationDuration} ease-in-out infinite alternate;
    }

    @keyframes breathe {
      0% {
        opacity: var(--base-opacity, 0.7);
        stroke-width: var(--base-width, 4);
      }
      100% {
        opacity: calc(var(--base-opacity, 0.7) + 0.15);
        stroke-width: calc(var(--base-width, 4) + 0.5);
      }
    }

    .date-label {
      font-family: ui-monospace, monospace;
      font-size: 8px;
      fill: #666;
    }

    .title {
      font-family: system-ui, sans-serif;
      font-size: 14px;
      fill: #333;
      font-weight: 600;
    }

    .subtitle {
      font-family: system-ui, sans-serif;
      font-size: 10px;
      fill: #888;
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
    ${dailyData.length > 0 ? paths : `
    <text x="${CONFIG.width / 2}" y="100" class="empty-state">
      The loom awaits its first thread...
    </text>
    <text x="${CONFIG.width / 2}" y="120" class="empty-state">
      Check back tomorrow to see the tapestry begin.
    </text>
    `}
  </g>

  <!-- Date markers -->
  <g id="dates">
    ${dateLabels}
  </g>

</svg>`;

  return svg;
}

// Main execution
function main() {
  console.log('🧵 Loading daily data...');
  const dailyData = loadDailyData();

  console.log(`📊 Found ${dailyData.length} days of data`);

  console.log('🎨 Weaving tapestry...');
  const svg = generateTapestry(dailyData);

  writeFileSync('tapestry.svg', svg);
  console.log('✨ Tapestry woven: tapestry.svg');

  if (dailyData.length > 0) {
    const latest = dailyData[0];
    console.log(`   Latest thread: ${latest.date}`);
    console.log(`   Dominant: ${latest.metrics.dominantLanguage}`);
  } else {
    console.log('   (Empty tapestry - awaiting first data)');
  }
}

main();
