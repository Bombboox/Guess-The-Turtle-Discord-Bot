const RSSParser = require('rss-parser');

const parser = new RSSParser({
  customFields: {
    item: [['media:thumbnail', 'thumbnail', { keepArray: false }]]
  }
});

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

  // Extract direct media link (i.redd.it or v.redd.it)
  const linkMatch = content.match(/href="(https?:\/\/(?:i|v)\.redd\.it\/[^"]+)"/);
  const link = linkMatch ? decodeHtml(linkMatch[1]) : null;

  // Extract preview image (preview.redd.it only, not external-preview)
  const imgMatch = content.match(/src="(https?:\/\/preview\.redd\.it\/[^"]+)"/);
  const image = imgMatch ? decodeHtml(imgMatch[1]) : null;

  return { image, link };
}

async function scrapeRedditTopPost() {
  console.log('Fetching r/turtle top posts via RSS...');

  const feed = await parser.parseURL('https://www.reddit.com/r/turtle/top/.rss?t=day');

  return feed.items.map(item => {
    const { image, link } = extractFromContent(item.content);

    const isVideo = link && link.includes('v.redd.it');
    const isImage = link && link.includes('i.redd.it');

    // Thumbnail from media:thumbnail field
    const thumbnail = item.thumbnail?.$?.url
      ? decodeHtml(item.thumbnail.$.url)
      : null;

    return {
      title: item.title,
      author: (item.author || '').replace('/u/', ''),
      score: null, // not in RSS feed
      comments: null, // not in RSS feed
      url: item.link?.replace('https://www.reddit.com', '') || null,
      images: isImage && image ? [image] : (thumbnail && !isVideo ? [thumbnail] : []),
      video: isVideo ? {
        src: link,
        poster: thumbnail
      } : null
    };
  });
}

module.exports = { scrapeRedditTopPost };