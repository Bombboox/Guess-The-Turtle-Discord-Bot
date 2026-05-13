const RSSParser = require('rss-parser');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';


const parser = new RSSParser({
  customFields: {
    item: [['media:thumbnail', 'thumbnail', { keepArray: false }]]
  },
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1'
  }
});

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

function decodeHtml(html) {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#32;/g, ' ')
    .replace(/&#39;/g, "'");
}

function extractFromContent(content) {
  if (!content) return { image: null, link: null };

  const linkMatch = content.match(/href="(https?:\/\/(?:i|v)\.redd\.it\/[^"]+)"/);
  const link = linkMatch ? decodeHtml(linkMatch[1]) : null;

  const imgMatch = content.match(/src="(https?:\/\/preview\.redd\.it\/[^"]+)"/);
  const image = imgMatch ? decodeHtml(imgMatch[1]) : null;

  return { image, link };
}

async function fetchVideoUrl(postUrl) {
  try {
    const path = postUrl.replace('https://old.reddit.com', '').replace('https://www.reddit.com', '');
    const jsonUrl = `https://old.reddit.com${path}.json`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    const res = await fetch(jsonUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.log(`fetchVideoUrl: got ${res.status} for ${jsonUrl}`);
      return null;
    }

    const data = await res.json();
    const postData = data[0]?.data?.children[0]?.data;

    const mp4 = postData?.media?.reddit_video?.fallback_url
      || postData?.secure_media?.reddit_video?.fallback_url
      || null;

    return mp4 ? mp4.replace(/&amp;/g, '&') : null;
  } catch (e) {
    console.error('fetchVideoUrl error:', e.message);
    return null;
  }
}

async function scrapeRedditTopPost() {
  console.log('Fetching r/turtle top posts via RSS...');

  const feed = await parser.parseURL('https://old.reddit.com/r/turtle/top/.rss?t=day');

  const posts = await Promise.all(feed.items.map(async item => {
    const { image, link } = extractFromContent(item.content);

    const isVideo = link && link.includes('v.redd.it');
    const isImage = link && link.includes('i.redd.it');

    const thumbnail = item.thumbnail?.$?.url
      ? decodeHtml(item.thumbnail.$.url).replace('width=140', 'width=640').replace('height=140&', '')
      : null;

    const postPath = item.link?.replace('https://www.reddit.com', '') || null;

    let videoSrc = null;
    if (isVideo && postPath) {
      console.log(`Fetching video URL for: ${item.title}`);
      videoSrc = await fetchVideoUrl(postPath);
    }

    return {
      title: item.title,
      author: (item.author || '').replace('/u/', ''),
      score: null,
      comments: null,
      url: postPath,
      images: isImage && image ? [image] : (thumbnail && !isVideo ? [thumbnail] : []),
      video: isVideo ? {
        src: videoSrc || link, // fallback to v.redd.it short link if fetch fails
        poster: thumbnail
      } : null
    };
  }));

  return posts;
}

module.exports = { scrapeRedditTopPost };