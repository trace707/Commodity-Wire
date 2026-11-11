#!/usr/bin/env node
// Pulls commodity headlines from public news-search RSS feeds, tags and scores
// them, merges with what we already have, and writes data/headlines.json.
// Zero dependencies - needs Node 18+ (global fetch).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.WIRE_OUT || resolve(ROOT, "data/headlines.json");
const KEEP_HOURS = 72;        // how long a headline stays on the board
const MAX_PER_COLUMN = 80;
const HEARTBEAT_MS = 5 * 60e3; // rewrite the file at least this often so the site can show the feed is alive
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// q    = Google News query, bing = Bing News query
// must = headline has to match this to land in the column, not = reject if it matches
export const COMMODITIES = {
  corn: {
    q: '"corn futures" OR "corn prices" OR "CBOT corn" OR "corn exports" OR "corn harvest" OR "corn yield"',
    bing: "corn futures prices CBOT",
    must: /\bcorn\b|\bmaize\b/i, not: /corn ?hole|popcorn|candy corn|corn maze|corn dog/i,
  },
  wheat: {
    q: '"wheat futures" OR "wheat prices" OR "CBOT wheat" OR "wheat exports" OR "wheat harvest" OR "wheat crop"',
    bing: "wheat futures prices",
    must: /wheat/i,
  },
  soybeans: {
    q: '"soybean futures" OR "soybean prices" OR "CBOT soybeans" OR "soybean exports" OR "soy futures" OR "soybean harvest"',
    bing: "soybean futures prices",
    must: /\bsoy/i,
  },
  gold: {
    q: '"gold prices" OR "gold price" OR "gold futures" OR "spot gold" OR "COMEX gold" OR bullion',
    bing: "gold price futures bullion",
    must: /\bgold\b|bullion/i, not: /medal|golden|gold cup|gold glove|gold coast|gold rush game/i,
  },
  silver: {
    q: '"silver prices" OR "silver price" OR "silver futures" OR "spot silver" OR "COMEX silver"',
    bing: "silver price futures",
    must: /\bsilver\b/i, not: /medal|silver lining|silver alert|silver screen|silver slugger/i,
  },
  copper: {
    q: '"copper prices" OR "copper price" OR "copper futures" OR "LME copper" OR "COMEX copper" OR "copper supply"',
    bing: "copper price futures LME",
    must: /\bcopper\b/i,
  },
  oil: {
    q: '"oil prices" OR "crude oil" OR "Brent crude" OR "WTI" OR "OPEC"',
    bing: "crude oil prices Brent WTI OPEC",
    must: /\boil\b|\bcrude\b|\bbrent\b|\bwti\b|opec/i,
    not: /palm oil|olive oil|cooking oil|soy(bean)? ?oil|essential oil|oil painting|fish oil|engine oil|motor oil/i,
  },
  "live-cattle": {
    q: '"live cattle" OR "cattle futures" OR "fed cattle" OR "boxed beef" OR "cattle on feed" OR "cattle prices"',
    bing: "live cattle futures boxed beef",
    must: /cattle|\bbeef\b/i, feederSplit: true,
  },
  "feeder-cattle": {
    q: '"feeder cattle" OR "feeder steers" OR "feeder calves" OR "calf prices" OR "stocker cattle" OR "cattle auction"',
    bing: "feeder cattle futures",
    must: /feeder|\bcalf\b|\bcalves\b|stocker|\bsteers\b|heifers|cattle auction|sale ?barn/i,
  },
  "lean-hogs": {
    q: '"lean hogs" OR "lean hog futures" OR "hog futures" OR "hog prices" OR "pork cutout" OR "hogs and pigs"',
    bing: "lean hog futures pork cutout",
    must: /\bhogs?\b|\bpork\b|\bpigs?\b|swine/i, not: /hedgehog|road hog|guinea pig|pork ?barrel|hog wild/i,
  },
};

// ---- importance / type tagging -------------------------------------------
const REPORT = /\b(WASDE|supply and demand (estimates|report)|crop progress|crop production|grain stocks|prospective plantings|acreage report|export sales|export inspections|cattle on feed|hogs and pigs|cold storage|cattle inventory|petroleum status|short[- ]term energy outlook|STEO|oil market report|OPEC\+? (meeting|decision|report|agrees|agreed|to (raise|cut|hold))|FOMC|Fed (decision|minutes|cuts|hikes|holds|meeting)|commitments? of traders|\bCOT\b|rig count|jobs report|non-?farm payrolls|payrolls|\bCPI\b|\bPCE\b|\bPPI\b)/i;
const DATA = /\b(settles?|settled|settlement|closes? (up|down|higher|lower|at)|inventor(y|ies)|stockpiles?|stocks (rise|fall|build|draw)|\bbuild\b|\bdraw\b|slaughter|cutout|exports? (rise|fall|jump|drop|hit|top|reach)|imports? (rise|fall|jump|drop|hit)|\bEIA\b|\bAPI\b|output (rises|falls)|production (rises|falls|estimate|forecast)|yield (estimate|forecast|cut|raised))/i;
const MOVE = /\b(surg|soar|plung|tumbl|slump|sink|sank|crash|spik|jump|rall(y|ies|ied)|slid|plummet|skyrocket|rout\b|sell-?off|record (high|low|close)|all[- ]time (high|low)|limit[- ](up|down)|(\d+|two|three|four|five|six|seven|eight|nine|ten)[- ](year|month|week)[- ](high|low)s?|(highest|lowest) (level )?(since|in)|multi-?(year|month|week))\w*/i;
const EVENT = /\b(tariffs?|sanctions?|ban(s|ned)?|embargo|strikes?|attack(s|ed)?|drought|flood(s|ing)?|frost|freeze|outbreak|bird flu|swine fever|screwworm|force majeure|shutdown|export (curb|quota|tax|ban)|ceasefire|hurricane|war\b|blockade|pipeline (leak|outage|blast)|refinery (fire|outage)|mine (closure|strike|collapse)|trade deal|recall)\b/i;
const WHO = /\b(USDA|EIA|IEA|OPEC|Fed|Federal Reserve|China|CFTC|CME|LME|White House|Trump|Saudi|Russia|Iran)\b/;
// retail price pages, chart pages and evergreen SEO filler - never market-moving
const NOISE = /price today|\bRs\.? ?[\d,]+|\blakh\b|bullion rates|10 ?gm|rates? today|per tola|\b(18|22|24)K\b|price chart|price prediction|current price of|check (latest )?rates|stock:|\bETF\b.*(buy|should you)|how to (buy|invest)|prices? (in|across) (pakistan|bangladesh|india|delhi|mumbai|chennai|kolkata|hyderabad|bengaluru|dubai|uae|nepal|egypt|saudi|qatar|kuwait|vietnam|the philippines)/i;
const FLASH = /^(breaking|alert|urgent|flash|just in)\b/i;

export function classify(title) {
  const isReport = REPORT.test(title), isData = DATA.test(title);
  let score = 0;
  if (isReport) score += 2;
  if (isData) score += 1;
  if (MOVE.test(title)) score += 1;
  if (EVENT.test(title)) score += 1;
  if (WHO.test(title)) score += 1;
  if (FLASH.test(title)) score += 2;
  // a named report, or a big move, is always worth a highlight; otherwise two signals are needed
  return { type: isReport ? "REPORT" : isData ? "DATA" : "NEWS", hot: score >= 2 || MOVE.test(title) };
}

// ---- RSS plumbing ----------------------------------------------------------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m)
  .replace(/\s+/g, " ").trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
};

export function parseRss(xml, feed) {
  const out = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    let title = tag(item, "title"), url = tag(item, "link");
    let src = tag(item, feed === "bing" ? "News:Source" : "source");
    const ts = Date.parse(tag(item, "pubDate"));
    if (!title || !url || Number.isNaN(ts)) continue;
    if (feed === "google" && src && title.endsWith(" - " + src)) title = title.slice(0, -src.length - 3);
    if (feed === "bing") {
      const real = url.match(/[?&]url=([^&]+)/);
      if (real) url = decodeURIComponent(real[1]);
      src = src.replace(/ on MSN$/i, "");
    }
    out.push({ title, url, src, ts });
  }
  return out;
}

const feedUrl = (feed, c) => feed === "google"
  ? `https://news.google.com/rss/search?q=${encodeURIComponent(`${c.q} when:1d`)}&hl=en-US&gl=US&ceid=US:en`
  : `https://www.bing.com/news/search?q=${encodeURIComponent(c.bing)}&format=rss&qft=${encodeURIComponent('sortbydate="1"')}`;

async function pull(feed, c) {
  const res = await fetch(feedUrl(feed, c), { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${feed} HTTP ${res.status}`);
  return parseRss(await res.text(), feed);
}

// Same story re-run by five outlets should show once: drop a headline when most
// of its words already appear in one we kept.
const words = (t) => new Set(norm(t).split(" ").filter((w) => w.length > 2));
export function dedupe(list) {
  const kept = [];
  for (const h of [...list].sort((a, b) => a.ts - b.ts)) {   // oldest wins: it broke the story
    const w = words(h.t);
    const dup = kept.some((k) => {
      let n = 0; for (const x of w) if (k.w.has(x)) n++;
      return n / Math.min(w.size, k.w.size) >= 0.75 && Math.abs(k.h.ts - h.ts) < 36 * 3600e3;
    });
    if (!dup) kept.push({ h, w });
  }
  return kept.map((k) => k.h);
}
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);
const idOf = (t) => createHash("sha1").update(norm(t)).digest("hex").slice(0, 12);

export function accept(key, title) {
  const c = COMMODITIES[key];
  if (/^BC-/i.test(title) || title.length < 25 || NOISE.test(title)) return false; // price tables, stubs, filler
  if (!c.must.test(title) || (c.not && c.not.test(title))) return false;
  // a pure feeder-cattle story belongs in the feeder column only
  if (c.feederSplit && /feeder/i.test(title) && !/live cattle|fed cattle|beef/i.test(title)) return false;
  return true;
}

// ---- main ------------------------------------------------------------------
async function main() {
  const now = Date.now();
  let prev = { commodities: {} };
  if (existsSync(OUT)) { try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch {} }

  // Alternate sources each minute so every column is refreshed every run while
  // each upstream only sees half the traffic. `--all` hits both for every column.
  const all = process.argv.includes("--all");
  const parity = Math.floor(now / 60e3) % 2;
  const keys = Object.keys(COMMODITIES);
  const errors = [];
  const fresh = Object.fromEntries(keys.map((k) => [k, []]));

  await Promise.all(keys.flatMap((key, i) => {
    const feeds = all ? ["google", "bing"] : [(i + parity) % 2 ? "google" : "bing"];
    return feeds.map(async (feed) => {
      try { fresh[key].push(...await pull(feed, COMMODITIES[key])); }
      catch (e) { errors.push(`${key}/${feed}: ${e.message}`); }
    });
  }));

  const commodities = {};
  let changed = false;
  for (const key of keys) {
    const byId = new Map((prev.commodities?.[key] ?? []).map((h) => [h.id, h]));
    const before = new Set(byId.keys());
    for (const it of fresh[key]) {
      if (!accept(key, it.title)) continue;
      const id = idOf(it.title);
      if (byId.has(id)) continue;
      byId.set(id, {
        id, t: it.title, src: it.src, url: it.url,
        ts: Math.min(it.ts, now),   // some feeds post-date items; never show the future
        seen: now, ...classify(it.title),
      });
    }
    const list = dedupe([...byId.values()])
      .filter((h) => now - h.ts < KEEP_HOURS * 3600e3)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_PER_COLUMN);
    if (list.length !== before.size || list.some((h) => !before.has(h.id))) changed = true;
    commodities[key] = list;
  }

  const stale = !prev.updated || now - Date.parse(prev.updated) > HEARTBEAT_MS;
  const total = Object.values(commodities).reduce((n, l) => n + l.length, 0);
  console.log(`${new Date(now).toISOString()} ${total} headlines, changed=${changed}` + (errors.length ? `, errors: ${errors.join("; ")}` : ""));
  if (changed || stale) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ updated: new Date(now).toISOString(), commodities }));
  }
  if (errors.length === keys.length * (all ? 2 : 1)) process.exit(1); // every feed failed
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
