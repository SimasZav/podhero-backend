/**
 * PodHero — Weekly Digest Worker
 */

import "dotenv/config";
import cron from "node-cron";
import { XMLParser } from "fast-xml-parser";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { Resend } from "resend";
import { fileURLToPath } from "url";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);
const xmlParser = new XMLParser({ ignoreAttributes: false });

// Only schedule the cron when worker.js is the entry point, not when imported
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  cron.schedule("0 7 * * 1", async () => {
    console.log("[worker] Starting weekly digest run...");
    await runWeeklyDigests();
  });
}

async function runWeeklyDigests() {
  try {
    const { data: users, error } = await supabase
      .from("users")
      .select("*, user_preferences(*)")
      .eq("active", true);

    if (error) throw error;
    console.log(`[worker] Processing ${users.length} active users`);

    // Fetch all podcast sources directly
    const { data: allSources } = await supabase.from("podcast_sources").select("*");
    console.log(`[worker] Ingesting ${allSources.length} podcast feeds`);

    const episodesByShow = {};
    for (const source of allSources) {
      try {
        const episodes = await fetchFeed(source);
        episodesByShow[source.title] = episodes;
      } catch (err) {
        console.error(`[rss] Error fetching ${source.title}:`, err.message);
      }
    }

    const allEpisodes = Object.values(episodesByShow).flat();
    console.log(`[worker] Summarizing ${allEpisodes.length} new episodes`);
    const summarizedEpisodes = await summarizeEpisodes(allEpisodes);

    for (const user of users) {
      try {
        await generateDigestForUser(user, summarizedEpisodes);
      } catch (err) {
        console.error(`[worker] Failed for ${user.email}:`, err.message);
      }
    }

    console.log("[worker] Weekly digest run complete.");
  } catch (err) {
    console.error("[worker] Fatal error:", err.message);
  }
}

async function fetchFeed(source) {
  const response = await fetch(source.feed_url, {
    headers: { "User-Agent": "PodHero/1.0 (podcast digest service)" },
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const xml = await response.text();
  const parsed = xmlParser.parse(xml);
  const items = parsed?.rss?.channel?.item || [];

  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  const recent = (Array.isArray(items) ? items : [items]).filter(item => {
    const pubDate = new Date(item.pubDate);
    return pubDate > oneWeekAgo;
  });

  const episodes = [];
  for (const item of recent) {
    const guid = item.guid?.["#text"] || item.guid || item.link;

    const episodeData = {
      podcast_id: source.id,
      guid: guid,
      title: item.title,
      description: item.description?.substring(0, 500) || "",
      audio_url: item.enclosure?.["@_url"] || null,
      duration: item["itunes:duration"] || null,
      pub_date: new Date(item.pubDate).toISOString(),
    };

    const { data, error } = await supabase
      .from("episodes")
      .upsert(episodeData, { onConflict: "guid", ignoreDuplicates: false })
      .select()
      .single();

    if (!error && data) {
      episodes.push({ ...data, showTitle: source.title });
    }
  }

  return episodes;
}

async function summarizeEpisodes(episodes) {
  const summarized = [];

  for (const episode of episodes) {
    const { data: existing } = await supabase
      .from("summaries")
      .select("*")
      .eq("episode_id", episode.id)
      .single();

    if (existing) {
      summarized.push({ ...episode, summary: existing });
      continue;
    }

    try {
      const summary = await summarizeEpisode(episode);
      summarized.push({ ...episode, summary });
    } catch (err) {
      console.error(`[claude] Failed to summarize "${episode.title}":`, err.message);
    }
  }

  return summarized;
}

async function summarizeEpisode(episode) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 800,
    messages: [
      {
        role: "user",
        content: `Summarize this podcast episode for a weekly digest email.

Show: ${episode.showTitle}
Title: ${episode.title}
Description: ${episode.description}

Return ONLY valid JSON:
{
  "summary": "2-3 sentence overview of the core ideas and why the conversation was notable",
  "takeaways": ["First key takeaway", "Second key takeaway", "Third key takeaway"],
  "quote": "A specific compelling insight from the description that captures the episode's spirit",
  "topics": ["topic1", "topic2", "topic3"]
}`,
      },
    ],
  });

  const text = message.content.map(b => b.text || "").join("");
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  const { data } = await supabase
    .from("summaries")
    .insert({ episode_id: episode.id, ...parsed })
    .select()
    .single();

  return data || parsed;
}

export async function generateDigestForUser(user, summarizedEpisodes) {
  const prefs = user.user_preferences?.[0];
  const interests = prefs?.interests || [];
  const trackedPodcasts = prefs?.podcasts || [];

  const scored = summarizedEpisodes
    .map(ep => ({
      ...ep,
      score: scoreEpisode(ep, interests, trackedPodcasts),
    }))
    .filter(ep => ep.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (scored.length === 0) {
    console.log(`[worker] No relevant episodes for ${user.email}, skipping`);
    return;
  }

  const intro = await generateIntro(scored, interests);

  const weekOf = getMonday(new Date()).toISOString().split("T")[0];

  // Check for existing digest this week — skip if already sent (idempotent retries)
  const { data: existing } = await supabase
    .from("digests")
    .select("id")
    .eq("user_id", user.id)
    .eq("week_of", weekOf)
    .single();

  if (existing) {
    console.log(`[worker] Digest already sent to ${user.email} for week ${weekOf}, skipping`);
    return;
  }

  const { error } = await supabase
    .from("digests")
    .insert({
      user_id: user.id,
      week_of: weekOf,
      intro,
      episode_ids: scored.map(ep => ep.id),
      sent_at: new Date().toISOString(),
    });

  if (error) throw error;

  await sendDigestEmail(user.email, { intro, episodes: scored, weekOf });
  console.log(`[worker] Digest sent to ${user.email}`);
}

async function generateIntro(episodes, interests) {
  const titles = episodes.map(ep => ep.title).join("; ");

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: `Write a 2-sentence editorial intro for a weekly podcast digest email.
User interests: ${interests.join(", ") || "technology, ideas"}.
This week's episodes cover: ${titles}.
Sound like a thoughtful editor. Be specific to the week's content, not generic.
Return ONLY the two sentences, no quotes, no extra formatting.`,
      },
    ],
  });

  return message.content.map(b => b.text || "").join("").trim();
}

function scoreEpisode(episode, interests, trackedPodcasts) {
  let score = 0;

  if (trackedPodcasts.some(p =>
    episode.showTitle?.toLowerCase().includes(p.toLowerCase())
  )) {
    score += 10;
  }

  const INTEREST_KEYWORDS = {
    tech:       ["ai", "software", "startup", "tech", "code", "model", "llm"],
    startup:    ["founder", "startup", "venture", "vc", "fundraise", "seed"],
    finance:    ["market", "macro", "fed", "rates", "invest", "equity", "fund"],
    product:    ["product", "design", "pm", "roadmap", "user", "ux"],
    health:     ["health", "longevity", "fitness", "sleep", "mental", "science"],
    culture:    ["culture", "media", "art", "music", "creative"],
    philosophy: ["philosophy", "ideas", "meaning", "ethics", "mind"],
    politics:   ["policy", "government", "politics", "regulation", "election"],
  };

  const text = `${episode.title} ${episode.description}`.toLowerCase();

  for (const interest of interests) {
    const keywords = INTEREST_KEYWORDS[interest] || [];
    if (keywords.some(kw => text.includes(kw))) {
      score += 3;
    }
  }

  const daysOld = (Date.now() - new Date(episode.pub_date).getTime()) / (1000 * 60 * 60 * 24);
  if (daysOld < 2) score += 2;
  else if (daysOld < 5) score += 1;

  return score;
}

async function sendDigestEmail(to, { intro, episodes, weekOf }) {
  const unsubscribeUrl = `${process.env.API_BASE_URL}/api/unsubscribe?email=${encodeURIComponent(to)}`;
  const html = buildEmailHTML({ intro, episodes, weekOf, unsubscribeUrl });

  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM,
    to,
    subject: `Your Weekly Podcast Digest — ${weekOf}`,
    html,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
}

function buildEmailHTML({ intro, episodes, weekOf, unsubscribeUrl }) {
  const episodeBlocks = episodes.map(ep => `
    <div style="border-bottom:1px solid #E8E0D2;padding:36px 0;">
      <p style="font-family:monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#2A5C38;margin:0 0 8px">
        ${ep.showTitle || ""}
      </p>
      <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:700;margin:0 0 8px;color:#1A1814;line-height:1.25">
        ${ep.title}
      </h2>
      <p style="font-size:13px;color:#6B6459;margin:0 0 16px;font-style:italic">
        ${ep.duration || ""}
      </p>
      <p style="font-size:14px;line-height:1.8;color:#3A3530;margin:0 0 20px">
        ${ep.summary?.summary || ""}
      </p>
      <div style="margin:0 0 20px">
        <p style="font-family:monospace;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#6B6459;margin:0 0 10px">
          Key Takeaways
        </p>
        ${(ep.summary?.takeaways || []).map(t => `
          <div style="display:flex;gap:10px;margin:0 0 8px">
            <span style="color:#2A5C38;margin-top:2px">•</span>
            <span style="font-size:13px;line-height:1.65;color:#3A3530">${t}</span>
          </div>
        `).join("")}
      </div>
      ${ep.summary?.quote ? `
        <blockquote style="border-left:2.5px solid #2A5C38;padding:12px 18px;margin:0 0 20px;background:#EEF5F0;font-style:italic;font-size:14px;color:#3A3530;line-height:1.7">
          "${ep.summary.quote}"
        </blockquote>
      ` : ""}
      <a href="${ep.audio_url || "#"}"
         style="display:inline-block;font-family:monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#2A5C38;border:1px solid #2A5C38;padding:9px 18px;text-decoration:none">
        Listen to full episode →
      </a>
    </div>
  `).join("");

  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
    <body style="margin:0;padding:0;background:#F2EDE3;font-family:Georgia,serif">
      <div style="max-width:620px;margin:0 auto;background:white;border:1px solid #DDD5C8">
        <div style="background:#1A1814;padding:44px 52px">
          <p style="font-family:monospace;font-size:10px;letter-spacing:2.5px;color:#9B9489;text-transform:uppercase;margin:0 0 12px">
            ${weekOf}
          </p>
          <h1 style="font-family:Georgia,serif;font-size:28px;font-weight:700;color:#F9F5EE;margin:0 0 20px;line-height:1.2">
            Your Weekly Podcast Briefing
          </h1>
          <p style="font-size:14px;color:#C0B8AE;line-height:1.75;margin:0;border-top:1px solid #2E2B27;padding-top:18px">
            ${intro}
          </p>
        </div>
        <div style="padding:8px 52px 52px">
          ${episodeBlocks}
        </div>
        <div style="background:#F2EDE3;border-top:1px solid #DDD5C8;padding:24px 52px;text-align:center;font-family:monospace;font-size:11px;color:#6B6459">
          <p style="margin:0">PodHero · Weekly Podcast Intelligence</p>
          <p style="margin:4px 0 0"><a href="${unsubscribeUrl}" style="color:#6B6459">Unsubscribe</a></p>
        </div>
      </div>
    </body>
    </html>
  `;
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

if (process.argv.includes("--run-now")) {
  console.log("[worker] Manual trigger — running digest pipeline now...");
  runWeeklyDigests().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { runWeeklyDigests };
