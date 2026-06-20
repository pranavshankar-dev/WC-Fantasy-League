// Clockstars WC 2026 fantasy pool — daily auto-updater
// Fetches all finished World Cup matches from football-data.org,
// recomputes every player's score, and rewrites index.html in place.
//
// Requires env var FOOTBALL_DATA_API_KEY (set as a GitHub Actions secret).

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const API_BASE = "https://api.football-data.org/v4";
const INDEX_PATH = path.join(__dirname, "..", "index.html");

if (!API_KEY) {
  console.error("Missing FOOTBALL_DATA_API_KEY env var. Aborting.");
  process.exit(1);
}

// ---------------------------------------------------------------------
// Player picks — edit this block whenever picks change.
// ---------------------------------------------------------------------
const players = [
  { name: "Ram", heroes: ["USA", "Brazil", "Netherlands", "Portugal"], villains: ["Iran", "Curacao", "Turkiye", "Sweden"] },
  { name: "Nandu", heroes: ["Brazil", "Spain", "Germany", "France"], villains: ["Haiti", "Cabo Verde", "New Zealand", "Tunisia"] },
  { name: "Shankar", heroes: ["England", "Germany", "Sweden", "Portugal"], villains: ["Australia", "Mexico", "Belgium", "Japan"] },
  { name: "Vibhav", heroes: ["France", "Germany", "Portugal", "Spain"], villains: ["Morocco", "Japan"] },
  { name: "Bach", heroes: ["Germany", "Portugal", "France", "Argentina"], villains: ["England", "USA", "Australia", "Saudi Arabia"] },
  { name: "Suveda", heroes: ["Argentina", "Germany", "Spain", "France"], villains: ["New Zealand", "Haiti", "Cabo Verde", "Ghana"] },
  { name: "Balaji", heroes: ["Spain", "France", "Germany", "Argentina"], villains: ["Portugal", "Australia", "Colombia", "Paraguay"] },
  { name: "Pranav", heroes: ["England", "France", "Argentina", "Germany"], villains: ["Egypt", "Norway", "Algeria", "Panama"] }
];

// Maps football-data.org's official team names to the short names used
// in the `players` picks above. Add an entry here if a team's API name
// doesn't match what's used in picks.
const NAME_MAP = {
  "United States": "USA",
  "Korea Republic": "South Korea",
  "Côte d'Ivoire": "Ivory Coast",
  "DR Congo": "DR Congo",
  "Türkiye": "Turkiye",
  "Curaçao": "Curacao",
  "Cabo Verde": "Cabo Verde",
  "Korea, South": "South Korea"
};

function normalizeTeamName(apiName) {
  return NAME_MAP[apiName] || apiName;
}

// Stage progression used for hero milestone bonuses and villain elimination bonus.
const STAGE_ORDER = ["group", "eliminated_group", "r32", "r16", "qf", "sf", "final", "champion"];
function stageRank(stage) {
  return STAGE_ORDER.indexOf(stage);
}

// ---------------------------------------------------------------------
// Fetch all WC matches from football-data.org
// ---------------------------------------------------------------------
async function fetchMatches() {
  const res = await fetch(`${API_BASE}/competitions/WC/matches`, {
    headers: { "X-Auth-Token": API_KEY }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`football-data.org request failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data.matches || [];
}

// ---------------------------------------------------------------------
// Build cumulative teamStats from finished matches
// ---------------------------------------------------------------------
function buildTeamStats(matches) {
  const stats = {};

  function ensure(team) {
    if (!stats[team]) {
      stats[team] = { goalsFor: 0, goalsAgainst: 0, wins: 0, losses: 0, draws: 0, stage: "group" };
    }
    return stats[team];
  }

  for (const m of matches) {
    if (m.status !== "FINISHED") continue;

    const home = normalizeTeamName(m.homeTeam.name);
    const away = normalizeTeamName(m.awayTeam.name);
    const homeGoals = m.score.fullTime.home;
    const awayGoals = m.score.fullTime.away;
    if (homeGoals === null || homeGoals === undefined || awayGoals === null || awayGoals === undefined) continue;

    const h = ensure(home);
    const a = ensure(away);

    h.goalsFor += homeGoals;
    h.goalsAgainst += awayGoals;
    a.goalsFor += awayGoals;
    a.goalsAgainst += homeGoals;

    if (homeGoals > awayGoals) {
      h.wins += 1;
      a.losses += 1;
    } else if (awayGoals > homeGoals) {
      a.wins += 1;
      h.losses += 1;
    } else {
      h.draws += 1;
      a.draws += 1;
    }

    // Knockout stage tracking: if this match's `stage` field indicates a
    // knockout round and it's finished, the winner advances and the loser
    // is eliminated (or both advance to next stage if still group/league).
    const stage = (m.stage || "").toUpperCase();
    const knockoutMap = {
      LAST_32: "r32",
      LAST_16: "r16",
      QUARTER_FINALS: "qf",
      SEMI_FINALS: "sf",
      FINAL: "final"
    };
    if (knockoutMap[stage]) {
      const tier = knockoutMap[stage];
      const winnerTeam = homeGoals > awayGoals ? home : awayGoals > homeGoals ? away : null;
      const loserTeam = homeGoals > awayGoals ? away : awayGoals > homeGoals ? home : null;
      if (winnerTeam) {
        const w = ensure(winnerTeam);
        if (stageRank(tier) > stageRank(w.stage)) w.stage = tier;
      }
      if (loserTeam) {
        const l = ensure(loserTeam);
        // Loser is eliminated at this stage; for scoring purposes that's
        // equivalent to "group" elimination logic not applying further —
        // mark as eliminated only if they were knocked out of the group
        // stage. Knockout-stage exits don't get the "eliminated_group" bonus.
      }
    }
  }

  return stats;
}

// After group stage completes, mark teams that did NOT advance as
// "eliminated_group". This requires standings, which we derive from
// group membership. football-data.org v4 returns `group` on group-stage
// matches as an enum like "GROUP_A". We rank teams within each group by
// points, then goal difference, then goals scored — standard tiebreakers
// — and mark the bottom two in each group of four as eliminated UNLESS
// the group stage isn't finished yet (some teams still have games left).
function markGroupEliminations(matches, stats) {
  const groups = {}; // groupName -> Set of team names
  const groupMatchesByTeam = {}; // team -> count of finished group matches

  for (const m of matches) {
    const groupName = m.group;
    if (!groupName || !groupName.toLowerCase().includes("group")) continue;
    const home = normalizeTeamName(m.homeTeam.name);
    const away = normalizeTeamName(m.awayTeam.name);
    groups[groupName] = groups[groupName] || new Set();
    groups[groupName].add(home);
    groups[groupName].add(away);

    if (m.status === "FINISHED") {
      groupMatchesByTeam[home] = (groupMatchesByTeam[home] || 0) + 1;
      groupMatchesByTeam[away] = (groupMatchesByTeam[away] || 0) + 1;
    }
  }

  for (const [groupName, teamSet] of Object.entries(groups)) {
    const teams = Array.from(teamSet);
    // Only evaluate eliminations once every team in the group has played
    // all 3 group matches.
    const allDone = teams.every((t) => (groupMatchesByTeam[t] || 0) >= 3);
    if (!allDone || teams.length < 3) continue;

    const ranked = teams
      .map((t) => {
        const s = stats[t] || { goalsFor: 0, goalsAgainst: 0, wins: 0, losses: 0, draws: 0 };
        const points = s.wins * 3 + s.draws;
        const gd = s.goalsFor - s.goalsAgainst;
        return { team: t, points, gd, gf: s.goalsFor };
      })
      .sort((x, y) => y.points - x.points || y.gd - x.gd || y.gf - x.gf);

    // Bottom 2 of a 4-team group are eliminated. (Approximation: ignores
    // the "best third-placed teams" cross-group rule, since that can't be
    // resolved from a single group's data. Revisit manually near the end
    // of the group stage if a 3rd-place team's fate is contested.)
    const eliminated = ranked.slice(2);
    for (const e of eliminated) {
      const s = stats[e.team];
      if (s && stageRank(s.stage) <= stageRank("group")) {
        s.stage = "eliminated_group";
      }
    }
    // Top 2 advance to r32, unless already further along.
    const advanced = ranked.slice(0, 2);
    for (const a of advanced) {
      const s = stats[a.team];
      if (s && stageRank(s.stage) < stageRank("r32")) {
        s.stage = "r32";
      }
    }
  }
}

// ---------------------------------------------------------------------
// Scoring logic — identical to the dashboard's in-browser logic.
// ---------------------------------------------------------------------
function scoreHero(stats, team) {
  const s = stats[team];
  if (!s) return 0;
  let pts = s.goalsFor * 2 + s.wins * 3;
  const r = stageRank(s.stage);
  if (r >= stageRank("r16")) pts += 5;
  if (r >= stageRank("sf")) pts += 10;
  if (r >= stageRank("final")) pts += 20;
  if (r >= stageRank("champion")) pts += 40;
  return pts;
}
function scoreVillain(stats, team) {
  const s = stats[team];
  if (!s) return 0;
  let pts = s.goalsAgainst * 2 + s.losses * 3;
  if (s.stage === "eliminated_group") pts += 5;
  return pts;
}

// ---------------------------------------------------------------------
// Regenerate index.html with fresh teamStats and timestamp.
// ---------------------------------------------------------------------
function buildTeamStatsBlock(stats) {
  const lines = Object.entries(stats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([team, s]) => {
      return `  ${JSON.stringify(team)}: { goalsFor: ${s.goalsFor}, goalsAgainst: ${s.goalsAgainst}, wins: ${s.wins}, losses: ${s.losses}, draws: ${s.draws}, stage: ${JSON.stringify(s.stage)} }`;
    });
  return `const teamStats = {\n${lines.join(",\n")}\n};`;
}

function updateIndexHtml(stats) {
  let html = fs.readFileSync(INDEX_PATH, "utf8");

  const newBlock = buildTeamStatsBlock(stats);
  html = html.replace(/const teamStats = \{[\s\S]*?\n\};/, newBlock);

  const now = new Date();
  const stamp = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short"
  });
  html = html.replace(
    /const LAST_UPDATED = ".*?";/,
    `const LAST_UPDATED = "${stamp} ET (auto-updated)";`
  );

  fs.writeFileSync(INDEX_PATH, html, "utf8");
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
(async () => {
  console.log("Fetching World Cup matches from football-data.org...");
  const matches = await fetchMatches();
  console.log(`Fetched ${matches.length} matches.`);

  const stats = buildTeamStats(matches);
  markGroupEliminations(matches, stats);

  // Quick sanity log: warn if any player's pick has no data at all
  // (e.g. a name mismatch between picks and API team names).
  for (const p of players) {
    for (const t of [...p.heroes, ...p.villains]) {
      if (!stats[t]) {
        console.warn(`WARNING: no match data found yet for team "${t}" (player ${p.name}). Check NAME_MAP if this team has played.`);
      }
    }
  }

  updateIndexHtml(stats);

  console.log("\n=== Player totals ===");
  for (const p of players) {
    const total =
      p.heroes.reduce((acc, t) => acc + scoreHero(stats, t), 0) +
      p.villains.reduce((acc, t) => acc + scoreVillain(stats, t), 0);
    console.log(`${p.name}: ${total}`);
  }

  console.log("\nindex.html updated successfully.");
})().catch((err) => {
  console.error("Update failed:", err);
  process.exit(1);
});
