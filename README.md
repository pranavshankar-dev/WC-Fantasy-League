# WC 2026 fantasy pool

A self-updating dashboard for the Clockstars World Cup fantasy pool.

## How it works

- `index.html` is the live dashboard, served via GitHub Pages.
- `scripts/update-pool.js` fetches finished World Cup matches from
  [football-data.org](https://www.football-data.org), recomputes every
  player's score, and rewrites the `teamStats` block inside `index.html`.
- `.github/workflows/update-pool.yml` runs that script automatically every
  day at 8am ET, then commits and pushes the updated file if anything
  changed. GitHub Pages redeploys automatically on every push to `main`.

## One-time setup

1. **Get a free API key** at https://www.football-data.org/client/register
   (no credit card required; free tier covers the World Cup, 10
   requests/minute).
2. In this repo, go to **Settings → Secrets and variables → Actions → New
   repository secret**. Name it `FOOTBALL_DATA_API_KEY` and paste the key.
3. That's it. The workflow will start running on its daily schedule. You
   can also trigger it manually any time from the **Actions** tab → "Update
   WC fantasy pool" → **Run workflow**.

## Editing player picks

Open `scripts/update-pool.js` and edit the `players` array near the top.
The same array also lives inside `index.html` for when the page renders —
keep both in sync. (Future improvement: have the script also rewrite the
`players` block in index.html so there's only one source of truth.)

## Known limitation: "best third-placed team" rule

The script marks teams as eliminated from the group stage once all three
group matches are finished, using points → goal difference → goals scored
as tiebreakers within each group of four. It does **not** model the
cross-group "8 best third-place teams advance" rule, since that requires
comparing third-place finishers across all 12 groups, not just one. Most
of the time this won't matter (clear 1st/2nd/3rd/4th splits are obvious),
but if a player's villain pick finishes 3rd in their group near the end of
the group stage, double check their elimination status manually rather
than trusting the auto-generated stage value blindly.

## Manual override

If you ever need to fix a data point by hand (e.g. the third-place-team
edge case above), you can edit the `teamStats` object directly in
`index.html`. The next scheduled run will overwrite it with fresh API
data, so manual edits are temporary unless you also update the script's
elimination logic.
