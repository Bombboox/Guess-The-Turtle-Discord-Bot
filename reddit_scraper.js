const { chromium } = require("playwright");

async function scrapeRedditTopPost() {
  console.log('Starting Reddit scrape for /r/turtle top daily posts...');
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ],
    proxy: {
      server: 'http://31.59.20.176:6754',
      username: 'hcjmywsp',
      password: 'kawunm1yqpx3'
    }
  });

  try {
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    });

    const targetUrl = "https://new.reddit.com/r/turtle/top/?t=day";
    console.log('Navigating to:', targetUrl);
    await page.goto(targetUrl, {
      waitUntil: "networkidle"
    });
    console.log(await page.title());
    console.log(await page.content().then(c => c.slice(0, 500)));

    console.log('Waiting for shreddit-post elements...');
    await page.waitForSelector("shreddit-post", { timeout: 15000 });
    console.log('Found shreddit-post element(s). Scrolling to load content...');
    await page.evaluate(() => window.scrollBy(0, 1000));
    await page.waitForTimeout(2000);

    const posts = await page.evaluate(() => {
      function deepQuery(root, selector) {
        const direct = root.querySelector(selector);
        if (direct) return direct;

        for (const child of root.querySelectorAll("*")) {
          if (child.shadowRoot) {
            const found = deepQuery(child.shadowRoot, selector);
            if (found) return found;
          }
        }
        return null;
      }

      function deepQueryAll(root, selector) {
        const results = [];
        results.push(...root.querySelectorAll(selector));

        for (const child of root.querySelectorAll("*")) {
          if (child.shadowRoot) {
            results.push(...deepQueryAll(child.shadowRoot, selector));
          }
        }
        return results;
      }

      const els = document.querySelectorAll("shreddit-post");

      return [...els].slice(0, 10).map((el) => {
        const allImages = deepQueryAll(el, "img")
          .filter(img => {
            const src = img.src || "";
            const alt = img.alt || "";
            const cls = img.className || "";

            return (
              !src.includes("styles.redditmedia.com") &&
              !src.includes("reddit-static.com/avatars") &&
              !alt.toLowerCase().includes("avatar") &&
              !alt.toLowerCase().includes("profile") &&
              !cls.includes("avatar") &&
              img.width > 50 &&
              img.height > 50
            );
          })
          .map(img => img.src || img.getAttribute("srcset")?.split(" ")[0] || null)
          .filter(Boolean)
          .slice(1);

        const video = deepQuery(el, "video");
        const videoSource = deepQuery(el, "video source");

        return {
          title: el.getAttribute("post-title"),
          author: el.getAttribute("author"),
          score: el.getAttribute("score"),
          comments: el.getAttribute("comment-count"),
          url: el.getAttribute("permalink"),
          images: allImages,
          video: video ? {
            src: video.src || videoSource?.src || null,
            poster: video.poster
          } : null,
        };
      });
    });

    console.log(`Scraped ${posts.length} Reddit post(s).`);
    posts.slice(0, 3).forEach((post, index) => {
      console.log(`Post #${index + 1}:`, {
        title: post.title,
        author: post.author,
        score: post.score,
        comments: post.comments,
        url: post.url,
        imageCount: post.images.length,
        hasVideo: !!post.video?.src
      });
    });

    return posts;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  scrapeRedditTopPost()
    .then((posts) => {
      if (!posts || posts.length === 0) {
        console.warn('No posts were scraped. The page structure may have changed.');
      } else {
        console.log('Scrape succeeded. First post payload:', posts[0]);
      }
    })
    .catch((err) => {
      console.error('Scrape failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { scrapeRedditTopPost };