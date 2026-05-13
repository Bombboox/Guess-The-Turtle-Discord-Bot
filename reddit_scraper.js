const { chromium } = require("playwright");

async function scrapeRedditTopPost() {
  const browser = await chromium.launch({
    headless: true
  });

  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
    });

    await page.goto("https://www.reddit.com/r/turtle/top/?t=day", {
      waitUntil: "networkidle"
    });

    await page.waitForSelector("shreddit-post");
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

    return posts;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeRedditTopPost };