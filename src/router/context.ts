/** Context Engine v0 — last-N blackboard entries + campaign brief */

import type { Db } from "../db/client.js";

export interface ContextBundle {
  campaignId: string | null;
  campaignSlug: string | null;
  brief: Record<string, unknown>;
  blackboardId: string | null;
  entries: Array<{
    id: string;
    entry_type: string;
    author_agent: string | null;
    content: Record<string, unknown>;
    created_at: string;
  }>;
  promptContext: string;
  summary: string;
}

const DEFAULT_N = 10;

function compressBrief(brief: Record<string, unknown>): string {
  const keys = Object.keys(brief);
  if (keys.length === 0) return "(empty brief)";
  try {
    const s = JSON.stringify(brief);
    if (s.length <= 800) return s;
    return s.slice(0, 797) + "...";
  } catch {
    return "(unserializable brief)";
  }
}

function compressEntry(e: {
  entry_type: string;
  author_agent: string | null;
  content: Record<string, unknown>;
}): string {
  let body: string;
  try {
    body = JSON.stringify(e.content);
  } catch {
    body = "{}";
  }
  if (body.length > 400) body = body.slice(0, 397) + "...";
  return `- [${e.entry_type}] ${e.author_agent ?? "unknown"}: ${body}`;
}

/**
 * Fetch last N blackboard entries for a campaign + compress brief into prompt context.
 * If campaignSlug is omitted, returns empty context (prompt-only invoke).
 */
export async function buildContext(
  db: Db,
  workspaceId: string,
  campaignSlug: string | undefined,
  lastN: number = DEFAULT_N
): Promise<ContextBundle> {
  if (!campaignSlug) {
    return {
      campaignId: null,
      campaignSlug: null,
      brief: {},
      blackboardId: null,
      entries: [],
      promptContext: "",
      summary: "no campaign context",
    };
  }

  const camp = await db.query<{
    id: string;
    slug: string;
    brief: Record<string, unknown>;
    blackboard_id: string | null;
  }>(
    `SELECT id, slug, brief, blackboard_id FROM campaigns
     WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [workspaceId, campaignSlug]
  );

  if (camp.rows.length === 0) {
    return {
      campaignId: null,
      campaignSlug,
      brief: {},
      blackboardId: null,
      entries: [],
      promptContext: `(campaign not found: ${campaignSlug})`,
      summary: `campaign ${campaignSlug} not found`,
    };
  }

  const c = camp.rows[0];
  const brief = (c.brief ?? {}) as Record<string, unknown>;
  let entries: ContextBundle["entries"] = [];

  if (c.blackboard_id) {
    const ent = await db.query<{
      id: string;
      entry_type: string;
      author_agent: string | null;
      content: Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT id, entry_type, author_agent, content, created_at::text
       FROM blackboard_entries
       WHERE blackboard_id = $1 AND deleted_at IS NULL
       ORDER BY sort_order DESC, created_at DESC
       LIMIT $2`,
      [c.blackboard_id, lastN]
    );
    entries = ent.rows.reverse(); // chronological for prompt
  }

  const parts: string[] = [
    `## Campaign brief (${c.slug})`,
    compressBrief(brief),
  ];
  if (entries.length > 0) {
    parts.push(`## Blackboard (last ${entries.length})`);
    for (const e of entries) parts.push(compressEntry(e));
  } else {
    parts.push("## Blackboard\n(empty)");
  }

  const promptContext = parts.join("\n");
  return {
    campaignId: c.id,
    campaignSlug: c.slug,
    brief,
    blackboardId: c.blackboard_id,
    entries,
    promptContext,
    summary: `campaign=${c.slug}; brief_keys=${Object.keys(brief).length}; bb_entries=${entries.length}`,
  };
}
