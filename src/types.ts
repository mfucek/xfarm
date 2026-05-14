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
  llm_context: string | null;
  llm_links: string | null;
  notified_at: string | null;
  seen_at: string | null;
  replied_at: string | null;
  hidden_at: string | null;
};

export type JudgeResult = {
  score: number;
  reason: string;
  suggested_angle: string;
  pitch_bullets: string[];
  /** Optional briefing on external entities the judge looked up (e.g. an app
   * mentioned in the tweet). Empty when no useful context was discovered. */
  context: string;
  /** External URLs the judge wants the user to click — homepage of an app
   * mentioned in the tweet, a referenced paper, etc. Usually empty;
   * occasionally 1, rarely 2. */
  links: string[];
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
