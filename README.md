# Commodity Wire

A live headline board with one column per market: corn, wheat, soybeans, gold,
silver, copper, oil, live cattle, feeder cattle and lean hogs. Important
headlines (named reports, data releases, big price moves, supply shocks) are
highlighted, tagged `REPORT` or `DATA`, and can trigger a beep or a desktop alert.
Each column also counts down to that market's next scheduled releases.

## How it works

- `scripts/fetch.mjs` pulls Google News and Bing News search feeds for each
  market, drops off-topic items, retail price pages and re-runs of the same
  story, scores what is left, and writes `headlines.json`.
- `.github/workflows/wire.yml` runs that script **once a minute** and publishes
  the result to the `data` branch (a single commit, replaced each time).
- `index.html` / `app.js` / `style.css` are a static page served by GitHub
  Pages. The page re-reads the `data` branch every 20 seconds.

## Setup (once)

1. Push this folder to a **public** GitHub repository (Actions minutes are free
   for public repositories; this workflow runs around the clock).
2. Settings -> Pages -> Source: **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Settings -> Actions -> General -> Workflow permissions: **Read and write**.
4. Actions -> **Headline feed** -> Run workflow (after that it restarts itself).

The site is then at `https://<owner>.github.io/<repo>/`.

## Tuning

Everything editable is at the top of `scripts/fetch.mjs`: the search queries
per market (`COMMODITIES`), and the word lists that decide what counts as a
`REPORT`, `DATA`, a big move or noise. The release schedule is `SCHEDULE` in
`app.js`.

Run it locally:

    node scripts/fetch.mjs --all
    python3 -m http.server 8000

## Limits worth knowing

- This is an aggregator of published articles, not a professional squawk. A
  headline appears a minute or two after a search feed indexes the article,
  which is itself minutes after the event.
- The Google and Bing feeds are licensed for personal, non-commercial use.
  For a commercial or resold product, swap in a licensed news API.
- Release times are the usual schedule and move in US holiday weeks. Monthly
  reports (WASDE, Cattle on Feed, CPI, FOMC) are not on the countdown; they
  still show up highlighted when they hit the news.
