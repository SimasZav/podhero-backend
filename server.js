/**
 * PodHero — Main API Server
 *
 * Endpoints:
 *   POST /api/subscribe       — create user + save preferences
 *   GET  /api/user/:email     — fetch user preferences
 *   PUT  /api/preferences     — update user preferences
 *   POST /api/digests/preview — generate a digest preview (no email sent)
 *   GET  /api/digests/:userId — list past digests for a user
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { runWeeklyDigests } from "./worker.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Clients ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── Health ───────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ─── GET /api/unsubscribe ─────────────────────────────────────
// One-click unsubscribe — linked from every digest email.
app.get("/api/unsubscribe", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).send("Missing email");

  const { error } = await supabase
    .from("users")
    .update({ active: false })
    .eq("email", email);

  if (error) {
    console.error("[unsubscribe]", error.message);
    return res.status(500).send("Failed to unsubscribe. Please try again.");
  }

  return res.send("You've been unsubscribed from PodHero. No more emails.");
});

// ─── POST /api/subscribe ──────────────────────────────────────
// Creates a new user and saves their preferences.
app.post("/api/subscribe", async (req, res) => {
  const { email, interests = [], podcasts = [], frequency = "weekly" } = req.body;

  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Valid email required" });
  }

  try {
    // Upsert user (idempotent — re-subscribing just reactivates)
    const { data: user, error: userErr } = await supabase
      .from("users")
      .upsert({ email, active: true }, { onConflict: "email" })
      .select()
      .single();

    if (userErr) throw userErr;

    // Upsert preferences
    const { error: prefErr } = await supabase
      .from("user_preferences")
      .upsert(
        { user_id: user.id, interests, podcasts, frequency, updated_at: new Date().toISOString() },
        { onConflict: "user_id" }
      );

    if (prefErr) throw prefErr;

    return res.status(201).json({
      message: "Subscribed successfully",
      userId: user.id,
    });
  } catch (err) {
    console.error("[subscribe]", err.message);
    return res.status(500).json({ error: "Failed to subscribe" });
  }
});

// ─── GET /api/user/:email ─────────────────────────────────────
app.get("/api/user/:email", async (req, res) => {
  const { email } = req.params;

  const { data: user, error } = await supabase
    .from("users")
    .select("*, user_preferences(*)")
    .eq("email", email)
    .single();

  if (error || !user) return res.status(404).json({ error: "User not found" });

  return res.json(user);
});

// ─── PUT /api/preferences ─────────────────────────────────────
app.put("/api/preferences", async (req, res) => {
  const { email, interests, podcasts, frequency } = req.body;

  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id")
    .eq("email", email)
    .single();

  if (userErr || !user) return res.status(404).json({ error: "User not found" });

  const updates = {};
  if (interests !== undefined) updates.interests = interests;
  if (podcasts !== undefined) updates.podcasts = podcasts;
  if (frequency !== undefined) updates.frequency = frequency;
  updates.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from("user_preferences")
    .update(updates)
    .eq("user_id", user.id);

  if (error) return res.status(500).json({ error: "Failed to update preferences" });

  return res.json({ message: "Preferences updated" });
});

// ─── POST /api/digests/preview ────────────────────────────────
// Generates a digest preview for a user without sending email.
// Used by the frontend to show the AI-generated digest immediately.
app.post("/api/digests/preview", async (req, res) => {
  const { email, interests = [], podcasts = [] } = req.body;

  if (!email) return res.status(400).json({ error: "Email required" });

  try {
    const digest = await generateDigestContent({ interests, podcasts });
    // Flag as sample so the frontend can display a clear disclaimer
    return res.json({ ...digest, isSample: true });
  } catch (err) {
    console.error("[digest/preview]", err.message);
    return res.status(500).json({ error: "Failed to generate digest preview" });
  }
});

// ─── GET /api/digests/:userId ─────────────────────────────────
app.get("/api/digests/:userId", async (req, res) => {
  const { userId } = req.params;

  const { data, error } = await supabase
    .from("digests")
    .select("*")
    .eq("user_id", userId)
    .order("week_of", { ascending: false })
    .limit(10);

  if (error) return res.status(500).json({ error: "Failed to fetch digests" });

  return res.json(data);
});

// ─── POST /api/digests/send-now ───────────────────────────────
// Admin endpoint: trigger a digest send for a specific user.
// Protect this in production with an admin secret header.
app.post("/api/digests/send-now", async (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== (process.env.ADMIN_KEY || "podhero-admin")) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    await runWeeklyDigests();
    return res.json({ message: "Digest sent" });
  } catch (err) {
    console.error("[send-now]", err.message);
    return res.status(500).json({ error: "Failed to send digest" });
  }
});

// ─── Helpers ──────────────────────────────────────────────────
export async function generateDigestContent({ interests, podcasts }) {
  const prompt = `You are PodHero's AI digest generator. Create a realistic, intellectually substantive weekly podcast digest.

User interests: ${interests.join(", ") || "technology, startups, ideas"}.
Tracked podcasts: ${podcasts.join(", ") || "Acquired, Lex Fridman, All-In Podcast"}.

Generate exactly 4 episode summaries. Each episode should feel like a real, specific conversation with distinct ideas.

Return ONLY valid JSON (no markdown, no backticks):
{
  "weekOf": "Week of March 17, 2026",
  "intro": "Two warm editorial sentences connecting this week's theme.",
  "episodes": [
    {
      "show": "exact show name",
      "title": "Specific interesting episode title",
      "guest": "Full Name or null",
      "duration": "1h 24m",
      "summary": "2-3 sentences on the core ideas",
      "takeaways": ["First takeaway", "Second takeaway", "Third takeaway"],
      "quote": "A specific memorable insight from the episode",
      "whyItMatters": "One sentence on relevance to the user's interests"
    }
  ]
}`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = message.content.map(b => b.text || "").join("");
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PodHero API running on http://localhost:${PORT}`);
});

export default app;
