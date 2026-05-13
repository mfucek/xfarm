export type ScrapedTweet = {
  id: string;
  author: string;
  authorFollowers: number | null;
  text: string;
  url: string;
  createdAt: string; // ISO 8601
  likes: number;
  replies: number;
  retweets: number;
};

export type TweetRow = {
  id: string;
  author: string;
  author_followers: number | null;
  text: string;
  url: string;
  created_at: string;
  discovered_at: string;
  source: string;
  likes: number;
  replies: number;
  retweets: number;
  last_polled_at: string | null;
  velocity: number | null;
  passed_gate_at: string | null;
  llm_score: number | null;
  llm_reason: string | null;
  llm_angle: string | null;
  llm_pitch: string | null;
  notified_at: string | null;
  seen_at: string | null;
  replied_at: string | null;
};

export type JudgeResult = {
  score: number;
  reason: string;
  suggested_angle: string;
  pitch_bullets: string[];
};

export type SuggestionVerdict = "add" | "remove" | "change";
export type SuggestionState = "pending" | "accepted" | "rejected";

export type SuggestionRow = {
  id: number;
  chunk_id: number;
  verdict: SuggestionVerdict;
  keyword: string;
  // For "change": the new keyword to insert in place of `keyword`.
  // NULL for "add" / "remove".
  replacement: string | null;
  reason: string;
  state: SuggestionState;
  created_at: string;
  resolved_at: string | null;
};
