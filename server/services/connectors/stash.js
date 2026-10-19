// Stash — GraphQL API at /graphql. Field naming differs between builds
// (older: snake_case, newer: camelCase), so we try both.
import { fmtBytesSI } from '../../core/util.js';

const STATS_CAMEL = `query { stats { sceneCount imageCount galleryCount performerCount studioCount tagCount sceneMarkerCount oCounter totalPlayCount totalPlayDuration totalSize } }`;
const STATS_SNAKE = `query { stats { scene_count image_count gallery_count performer_count studio_count tag_count scene_marker_count o_counter total_play_count total_play_duration total_size } }`;

function headers(ctx) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (ctx.apiKey) h['ApiKey'] = ctx.apiKey; // undici sends header names lowercased anyway — set it once
  const basic = ctx.basicHeader();
  if (basic) h['Authorization'] = basic;
  return h;
}

async function gql(ctx, query) {
  const res = await ctx.api('/graphql', {
    method: 'POST',
    headers: headers(ctx),
    body: JSON.stringify({ query }),
    timeoutMs: 15000,
  });
  if (res.json?.errors?.length) {
    const msg = res.json.errors[0]?.message || 'GraphQL error';
    throw new Error(msg);
  }
  return res.json?.data;
}

function fmtDuration(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function fetchStats(ctx) {
  try {
    const data = await gql(ctx, STATS_CAMEL);
    if (data?.stats) return { stats: data.stats, camel: true };
  } catch (err) {
    if (!/Cannot query field/i.test(err.message)) throw err;
  }
  const data = await gql(ctx, STATS_SNAKE);
  if (!data?.stats) throw new Error('Stats query returned no data');
  return { stats: data.stats, camel: false };
}

export default {
  async test(ctx) {
    if (!ctx.base) return { ok: false, message: 'URL is required' };
    try {
      const { stats } = await fetchStats(ctx);
      const scenes = stats.sceneCount ?? stats.scene_count;
      return { ok: true, message: `Connected — ${scenes ?? '?'} scenes` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  },

  async poll(ctx) {
    const { stats } = await fetchStats(ctx);
    const get = (camel, snake) => stats[camel] ?? stats[snake];

    const out = [
      { label: 'Scenes', value: get('sceneCount', 'scene_count') ?? '–', emphasis: true },
      { label: 'Images', value: get('imageCount', 'image_count') ?? '–' },
      { label: 'Galleries', value: get('galleryCount', 'gallery_count') ?? '–' },
      { label: 'Performers', value: get('performerCount', 'performer_count') ?? '–' },
      { label: 'Tags', value: get('tagCount', 'tag_count') ?? '–' },
    ];
    const plays = get('totalPlayCount', 'total_play_count');
    if (plays) out.push({ label: 'Plays', value: plays });
    const dur = fmtDuration(get('totalPlayDuration', 'total_play_duration'));
    if (dur) out.push({ label: 'Watch time', value: dur });
    const size = fmtBytesSI(get('totalSize', 'total_size'));
    if (size) out.push({ label: 'Library size', value: size });

    return { stats: out, charts: {} };
  },
};
