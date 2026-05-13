const RSSParser = require('rss-parser');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const parser = new RSSParser({
  customFields: {
    item: [['media:thumbnail', 'thumbnail', { keepArray: false }]],
  },
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  },
});

const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));

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
  if (!content) return { image: null, directLink: null, isGallery: false };

  // Direct image/video link (i.redd.it or v.redd.it)
  const linkMatch = content.match(
    /href="(https?:\/\/(?:i|v)\.redd\.it\/[^"]+)"/
  );
  const directLink = linkMatch ? decodeHtml(linkMatch[1]) : null;

  // Preview image (higher quality than thumbnail)
  const imgMatch = content.match(
    /src="(https?:\/\/preview\.redd\.it\/[^"]+)"/
  );
  const image = imgMatch ? decodeHtml(imgMatch[1]) : null;

  // Gallery posts link to reddit.com/gallery/...
  const isGallery = /href="https?:\/\/(?:www\.)?reddit\.com\/gallery\//.test(
    content
  );

  return { image, directLink, isGallery };
}

const { HttpsProxyAgent } = require('https-proxy-agent');

const PROXY_URL = `http://hcjmywsp:kawunm1yqpx3@31.59.20.176:6754`;
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

async function fetchPostJson(postUrl) {
  try {
    const path = postUrl
      .replace('https://old.reddit.com', '')
      .replace('https://www.reddit.com', '');
    const jsonUrl = `https://old.reddit.com${path}.json`;

    const res = await fetch(jsonUrl, {
      agent: proxyAgent,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return null;

    const data = await res.json();
    return data[0]?.data?.children[0]?.data ?? null;
  } catch (e) {
    console.error('fetchPostJson error:', e.message);
    return null;
  }
}

/** Extract all image URLs from a post's JSON data */
function extractImagesFromPostData(postData) {
  if (!postData) return [];

  const images = [];

  // Single image post
  if (postData.url && /\.(jpg|jpeg|png|gif|webp)$/i.test(postData.url)) {
    images.push(postData.url);
    return images;
  }

  // Gallery post — media_metadata holds all images
  if (postData.is_gallery && postData.media_metadata) {
    for (const item of Object.values(postData.media_metadata)) {
      if (item.status !== 'valid') continue;

      // Prefer the largest 'p' (preview) resolution, fallback to 's' (source)
      if (item.p && item.p.length > 0) {
        const largest = item.p[item.p.length - 1];
        images.push(decodeHtml(largest.u));
      } else if (item.s?.u) {
        images.push(decodeHtml(item.s.u));
      } else if (item.s?.gif) {
        images.push(decodeHtml(item.s.gif));
      }
    }
    return images;
  }

  // preview.reddit.com resolutions (non-gallery image posts)
  const previews = postData.preview?.images;
  if (previews && previews.length > 0) {
    const resolutions = previews[0].resolutions;
    if (resolutions && resolutions.length > 0) {
      // Pick the highest available resolution
      const largest = resolutions[resolutions.length - 1];
      images.push(decodeHtml(largest.url));
    } else if (previews[0].source?.url) {
      images.push(decodeHtml(previews[0].source.url));
    }
  }

  return images;
}

/** Extract Reddit-hosted MP4 URL from post data */
function extractVideoFromPostData(postData) {
  if (!postData) return null;
  const vid =
    postData.media?.reddit_video ?? postData.secure_media?.reddit_video;
  if (!vid) return null;
  return {
    src: decodeHtml(vid.fallback_url ?? vid.hls_url ?? ''),
    poster: null, // filled in below
  };
}

async function scrapeRedditTopPosts() {
  console.log('Fetching r/turtle top posts via RSS...');

  const feed = await parser.parseURL(
    'https://old.reddit.com/r/turtle/top/.rss?t=day'
  );

  const posts = await Promise.all(
    feed.items.map(async (item) => {
      const { image, directLink, isGallery } = extractFromContent(
        item.content
      );

      const isVideo =
        directLink && directLink.includes('v.redd.it');
      const isDirectImage =
        directLink && directLink.includes('i.redd.it');

      // Decode thumbnail URL from media:thumbnail attribute
      const thumbnailRaw = item.thumbnail?.$?.url
        ? decodeHtml(item.thumbnail.$.url)
        : null;

      const postUrl = item.link ?? null;

      const needsJson = !!postUrl;
      const postData = needsJson && postUrl ? await fetchPostJson(postUrl) : null;

      // --- Images ---
      let images = [];

      if (isGallery && postData) {
        images = extractImagesFromPostData(postData);
      } else if (postData) {
        // Always prefer full-res from post JSON
        images = extractImagesFromPostData(postData);
      } else if (isDirectImage) {
        images = [directLink];
      } else if (image) {
        images = [image];
      } else if (thumbnailRaw) {
        images = [thumbnailRaw];
      }

      // --- Video ---
      let video = null;
      if (isVideo && postData) {
        video = extractVideoFromPostData(postData);
        if (video) video.poster = thumbnailRaw;
      }

      return {
        title: item.title,
        author: (item.author ?? '').replace('/u/', ''),
        url: postUrl,
        images,
        video,
      };
    })
  );

  return posts;
}

module.exports = { scrapeRedditTopPosts };