const { INAT_USER_AGENT } = require('./config');

const FEED_URL = 'https://www.reddit.com/r/turtle/top.rss?t=day&limit=1';

function decodeEntities(s) {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

let cache = { post: null, at: 0 };

// Fetch the top r/turtle post of the last 24 hours via the RSS feed.
// Returns { title, link, images, videos } or null if the feed is empty.
async function fetchTopTurtlePost() {
  if (cache.post && Date.now() - cache.at < 60_000) return cache.post;

  const res = await fetch(FEED_URL, {
    headers: { 'User-Agent': INAT_USER_AGENT },
  });
  if (!res.ok) throw new Error(`Reddit returned ${res.status}`);
  const xml = await res.text();

  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) return null;

  const title = decodeEntities(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || 'Untitled');
  const link = entry.match(/<link href="([^"]+)"/)?.[1] || 'https://www.reddit.com/r/turtle/';
  const content = decodeEntities(entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || '');

  // Collect image URLs from the post body, upgrading preview thumbnails to
  // full size. external-preview.redd.it images are just thumbnails for
  // video/link posts, so skip those.
  const images = [];
  for (const [, src] of content.matchAll(/<img src="([^"]+)"/g)) {
    const url = decodeEntities(src);
    if (url.startsWith('https://external-preview.redd.it/')) continue;
    const preview = url.match(/^https:\/\/preview\.redd\.it\/([\w-]+\.(?:jpg|jpeg|png|gif|webp))/i);
    images.push(preview ? `https://i.redd.it/${preview[1]}` : url);
  }

  // Reddit-hosted videos show up as v.redd.it links in the post body.
  const videos = [];
  for (const [, href] of content.matchAll(/<a href="(https:\/\/v\.redd\.it\/[^"]+)"/g)) {
    const url = decodeEntities(href);
    if (!videos.includes(url)) videos.push(url);
  }

  cache = { post: { title, link, images, videos }, at: Date.now() };
  return cache.post;
}

module.exports = { fetchTopTurtlePost };
