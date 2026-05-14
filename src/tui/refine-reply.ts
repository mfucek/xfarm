import { Judge } from "../judge/index.ts";
import { isNaumuEnabled, NaumuMcpClient } from "../judge/naumu-mcp.ts";
import type { TweetRow } from "../types.ts";
import { parseStringArrayColumn } from "./ansi.ts";
import type { TuiHost } from "./types.ts";

/**
 * Generate one additional reply-idea bullet steered by the user's typed
 * feedback, append it to `tweets.llm_pitch`, and refresh the detail view.
 *
 * Mirrors `runTestJudge` (tweet-detail-items.ts): spawns its own Naumu MCP
 * client + Judge per call, drives a 100ms redraw timer for the spinner,
 * and reuses `db.markJudged` to persist the appended bullet alongside the
 * tweet's existing judge fields (so we don't disturb score/angle/links).
 */
export async function runRefineReplyIdea(
  host: TuiHost,
  r: TweetRow,
  userPrompt: string,
  subjectBullet: string,
): Promise<void> {
  host.tweetDetailRefineStatus = "Warming up…";
  host.draw();
  const spinnerTimer = setInterval(() => host.draw(), 100);

  const naumu = isNaumuEnabled(host.cfg) ? new NaumuMcpClient(host.cfg) : null;
  if (naumu) {
    host.tweetDetailRefineStatus = "Connecting to Naumu…";
    host.draw();
    const connectPromise = naumu.connect();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([connectPromise, timeout]);
  }

  try {
    const judge = new Judge(host.cfg, naumu);
    const currentBullets = parseStringArrayColumn(r.llm_pitch);
    const bullet = await judge.refineReplyIdea(r, {
      userPrompt,
      currentAngle: r.llm_angle,
      currentBullets,
      subjectBullet,
      onStatus: (s) => {
        host.tweetDetailRefineStatus = s;
      },
    });

    const appended = [...currentBullets, bullet];
    host.db.markJudged(
      r.id,
      r.llm_score ?? 0,
      r.llm_reason ?? "",
      r.llm_angle ?? "",
      appended,
      r.llm_context ?? "",
      parseStringArrayColumn(r.llm_links),
    );
    r.llm_pitch = JSON.stringify(appended);
    host.flash("reply idea added", 4000);
  } catch (e) {
    host.flash(`refine failed: ${(e as Error).message}`, 6000);
  } finally {
    clearInterval(spinnerTimer);
    host.tweetDetailRefineStatus = null;
    if (naumu) {
      try {
        await naumu.close();
      } catch {
        /* best effort */
      }
    }
    host.draw();
  }
}
