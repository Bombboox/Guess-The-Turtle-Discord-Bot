const RSSParser = require('rss-parser');
const { HttpsProxyAgent } = require('https-proxy-agent');

const PROXY_URL = `http://hcjmywsp:kawunm1yqpx3@23.95.150.145:6114`;
const proxyAgent = new HttpsProxyAgent(PROXY_URL);

// Rotate between a few common user agents to look less repetitive
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDelay(min = 800, max = 2500) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}

const parser = new RSSParser({
  customFields: {
    item: [['media:thumbnail', 'thumbnail', { keepArray: false }]],
  },
  headers: {
    'User-Agent': randomUserAgent(),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    Cookie: `token_v2=${process.env.REDDIT_TOKEN_V2}; session_tracker=${process.env.REDDIT_SESSION_TRACKER}`,
  },
  requestOptions: { agent: proxyAgent },
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

  const linkMatch = content.match(
    /href="(https?:\/\/(?:i|v)\.redd\.it\/[^"]+)"/
  );
  const directLink = linkMatch ? decodeHtml(linkMatch[1]) : null;

  const imgMatch = content.match(
    /src="(https?:\/\/preview\.redd\.it\/[^"]+)"/
  );
  const image = imgMatch ? decodeHtml(imgMatch[1]) : null;

  const isGallery = /href="https?:\/\/(?:www\.)?reddit\.com\/gallery\//.test(content);

  return { image, directLink, isGallery };
}

async function fetchPostJson(postUrl) {
  try {
    const path = postUrl
      .replace('https://old.reddit.com', '')
      .replace('https://www.reddit.com', '');
    const jsonUrl = `https://old.reddit.com${path}.json`;

    const res = await fetch(jsonUrl, {
      agent: proxyAgent,
      headers: {
        'User-Agent': randomUserAgent(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        Referer: 'https://old.reddit.com/r/turtle/',
        Cookie: `token_v2=${process.env.REDDIT_TOKEN_V2}; session_tracker=${process.env.REDDIT_SESSION_TRACKER}`,
  
      },
  });

    console.log('STATUS:', res.status, jsonUrl);

    if (!res.ok) {
      const denyReason = res.headers.get('x-deny-reason');
      const body = await res.text();
      console.error('DENY REASON:', denyReason);
      console.error('RESPONSE BODY:', body.slice(0, 500));
      return null;
    }

    const data = await res.json();
    return data[0]?.data?.children[0]?.data ?? null;
  } catch (e) {
    console.error('fetchPostJson error:', e.message);
    return null;
  }
}

function extractImagesFromPostData(postData) {
  if (!postData) return [];

  const images = [];

  if (postData.url && /\.(jpg|jpeg|png|gif|webp)$/i.test(postData.url)) {
    images.push(postData.url);
    return images;
  }

  if (postData.is_gallery && postData.media_metadata) {
    for (const item of Object.values(postData.media_metadata)) {
      if (item.status !== 'valid') continue;
      if (item.p && item.p.length > 0) {
        images.push(decodeHtml(item.p[item.p.length - 1].u));
      } else if (item.s?.u) {
        images.push(decodeHtml(item.s.u));
      } else if (item.s?.gif) {
        images.push(decodeHtml(item.s.gif));
      }
    }
    return images;
  }

  const previews = postData.preview?.images;
  if (previews && previews.length > 0) {
    const resolutions = previews[0].resolutions;
    if (resolutions && resolutions.length > 0) {
      images.push(decodeHtml(resolutions[resolutions.length - 1].url));
    } else if (previews[0].source?.url) {
      images.push(decodeHtml(previews[0].source.url));
    }
  }

  return images;
}

function extractVideoFromPostData(postData) {
  if (!postData) return null;
  const vid = postData.media?.reddit_video ?? postData.secure_media?.reddit_video;
  if (!vid) return null;
  return {
    src: decodeHtml(vid.fallback_url ?? vid.hls_url ?? ''),
    poster: null,
  };
}

async function scrapeRedditTopPosts() {
  console.log('Fetching r/turtle top post via RSS...');

  const feed = await parser.parseURL(
    'https://old.reddit.com/r/turtle/top/.rss?t=day'
  );

  const item = feed.items[0];
  if (!item) return [];

  const { image, directLink, isGallery } = extractFromContent(item.content);

  const isVideo = directLink && directLink.includes('v.redd.it');
  const isDirectImage = directLink && directLink.includes('i.redd.it');

  const thumbnailRaw = item.thumbnail?.$?.url
    ? decodeHtml(item.thumbnail.$.url)
    : null;

  const postUrl = item.link ?? null;

  // Small random delay before fetching to look more human
  await randomDelay();
  const postData = postUrl ? await fetchPostJson(postUrl) : null;

  let images = [];
  if (postData) {
    images = extractImagesFromPostData(postData);
  } else if (isDirectImage) {
    images = [directLink];
  } else if (image) {
    images = [image];
  } else if (thumbnailRaw) {
    images = [thumbnailRaw];
  }

  let video = null;
  if (isVideo && postData) {
    video = extractVideoFromPostData(postData);
    if (video) video.poster = thumbnailRaw;
  }

  return [{
    title: item.title,
    author: (item.author ?? '').replace('/u/', ''),
    url: postUrl,
    images,
    video,
  }];
}

module.exports = { scrapeRedditTopPosts };