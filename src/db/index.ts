import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SuggestionRow, TweetRow } from "../types.ts";
import * as analytics from "./analytics.ts";
import * as authors from "./authors.ts";
import * as feeds from "./feeds.ts";
import * as keywords from "./keywords.ts";
import * as maintenance from "./maintenance.ts";
import { runMigrations, SCHEMA } from "./schema.ts";
import * as suggestions from "./suggestions.ts";
import * as tweets from "./tweets.ts";

/**
 * Thin facade around the per-entity modules. Public method names match the
 * pre-split API so consumers keep working unchanged. Each method delegates
 * to its module; logic lives there.
 */
export class DB {
  private db: Database;

  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec(SCHEMA);
    runMigrations(this.db);
    // Indexes that reference migration-added columns go here so they survive
    // a first-boot on a pre-existing DB.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tweets_unchunked
         ON tweets(discovered_at) WHERE suggestion_chunk_id IS NULL`,
    );
  }

  close(): void {
    this.db.close();
  }

  // ---------- authors ----------
  syncAuthors(rows: { handle: string; tier: number }[]): void {
    authors.syncAuthors(this.db, rows);
  }
  authorTier(handle: string): number | null {
    return authors.authorTier(this.db, handle);
  }
  oldestAuthor(): ReturnType<typeof authors.oldestAuthor> {
    return authors.oldestAuthor(this.db);
  }
  authorsDue(intervalSec: number): { handle: string; tier: number }[] {
    return authors.authorsDue(this.db, intervalSec);
  }
  markAuthorScanned(handle: string): void {
    authors.markAuthorScanned(this.db, handle);
  }

  // ---------- keywords ----------
  syncKeywords(queries: string[]): void {
    keywords.syncKeywords(this.db, queries);
  }
  addKeyword(q: string): boolean {
    return keywords.addKeyword(this.db, q);
  }
  removeKeyword(q: string): boolean {
    return keywords.removeKeyword(this.db, q);
  }
  listKeywords(): { query: string; last_scanned_at: string | null }[] {
    return keywords.listKeywords(this.db);
  }
  oldestKeyword(): ReturnType<typeof keywords.oldestKeyword> {
    return keywords.oldestKeyword(this.db);
  }
  keywordsDue(intervalSec: number): string[] {
    return keywords.keywordsDue(this.db, intervalSec);
  }
  markKeywordScanned(q: string): void {
    keywords.markKeywordScanned(this.db, q);
  }

  // ---------- feeds ----------
  syncFeeds(rows: { name: string; interval_sec: number }[]): void {
    feeds.syncFeeds(this.db, rows);
  }
  oldestFeed(): ReturnType<typeof feeds.oldestFeed> {
    return feeds.oldestFeed(this.db);
  }
  listFeeds(): ReturnType<typeof feeds.listFeeds> {
    return feeds.listFeeds(this.db);
  }
  markFeedScanned(name: string): void {
    feeds.markFeedScanned(this.db, name);
  }

  // ---------- tweets ----------
  upsertTweet(t: Parameters<typeof tweets.upsertTweet>[1]): boolean {
    return tweets.upsertTweet(this.db, t);
  }
  updateEngagement(
    id: string,
    likes: number,
    replies: number,
    retweets: number,
    velocity: number,
  ): void {
    tweets.updateEngagement(this.db, id, likes, replies, retweets, velocity);
  }
  markGatePassed(id: string): void {
    tweets.markGatePassed(this.db, id);
  }
  markJudged(
    id: string,
    score: number,
    reason: string,
    angle: string,
    pitchBullets: string[],
    context: string,
    links: string[],
  ): void {
    tweets.markJudged(
      this.db,
      id,
      score,
      reason,
      angle,
      pitchBullets,
      context,
      links,
    );
  }
  markNotified(id: string): void {
    tweets.markNotified(this.db, id);
  }
  markSeen(id: string): void {
    tweets.markSeen(this.db, id);
  }
  markReplied(id: string): void {
    tweets.markReplied(this.db, id);
  }
  markHidden(id: string): void {
    tweets.markHidden(this.db, id);
  }
  fetchTrackingSet(maxAgeHours: number): string[] {
    return tweets.fetchTrackingSet(this.db, maxAgeHours);
  }
  fetchDueForJudge(limit = 20): TweetRow[] {
    return tweets.fetchDueForJudge(this.db, limit);
  }
  fetchDueForNotify(threshold: number, limit = 5): TweetRow[] {
    return tweets.fetchDueForNotify(this.db, threshold, limit);
  }
  fetchActive(maxAgeHours: number, limit = 50): TweetRow[] {
    return tweets.fetchActive(this.db, maxAgeHours, limit);
  }
  fetchNonCandidates(maxAgeHours: number, limit = 50): TweetRow[] {
    return tweets.fetchNonCandidates(this.db, maxAgeHours, limit);
  }
  oldestStaleTrackedTweet(
    intervalSec: number,
    maxAgeHours: number,
  ): { id: string } | null {
    return tweets.oldestStaleTrackedTweet(this.db, intervalSec, maxAgeHours);
  }

  // ---------- suggestions ----------
  unchunkedTweetCount(): number {
    return suggestions.unchunkedTweetCount(this.db);
  }
  claimNextSuggestionChunk(
    size: number,
  ): { chunkId: number; tweets: TweetRow[] } | null {
    return suggestions.claimNextSuggestionChunk(this.db, size);
  }
  markChunkJudged(chunkId: number): void {
    suggestions.markChunkJudged(this.db, chunkId);
  }
  markChunkFailed(chunkId: number, err: string): void {
    suggestions.markChunkFailed(this.db, chunkId, err);
  }
  insertSuggestions(
    chunkId: number,
    rows: Parameters<typeof suggestions.insertSuggestions>[2],
  ): void {
    suggestions.insertSuggestions(this.db, chunkId, rows);
  }
  listPendingSuggestions(): SuggestionRow[] {
    return suggestions.listPendingSuggestions(this.db);
  }
  resolveSuggestion(
    id: number,
    state: "accepted" | "rejected",
  ): SuggestionRow | null {
    return suggestions.resolveSuggestion(this.db, id, state);
  }
  resolveAllPendingSuggestions(
    state: "accepted" | "rejected",
  ): SuggestionRow[] {
    return suggestions.resolveAllPendingSuggestions(this.db, state);
  }
  fetchSuggestionEvidence(
    chunkId: number,
    keyword: string,
    limit = 5,
  ): TweetRow[] {
    return suggestions.fetchSuggestionEvidence(this.db, chunkId, keyword, limit);
  }

  // ---------- analytics ----------
  stats(): analytics.Stats {
    return analytics.stats(this.db);
  }
  recentActivity(windowSec: number, buckets: number): analytics.Activity {
    return analytics.recentActivity(this.db, windowSec, buckets);
  }
  bumpCounter(name: string): void {
    analytics.bumpCounter(this.db, name);
  }

  // ---------- maintenance ----------
  clearScanCooldowns(): number {
    return maintenance.clearScanCooldowns(this.db);
  }
  clearLowEngagementOldTweets(minAgeSec: number): number {
    return maintenance.clearLowEngagementOldTweets(this.db, minAgeSec);
  }
  clearSuggestionsHistory(): number {
    return maintenance.clearSuggestionsHistory(this.db);
  }
}
