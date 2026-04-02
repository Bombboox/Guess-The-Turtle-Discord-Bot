const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const URL = "https://turtleowner.com/complete-list-of-turtle-species/";

axios.get(URL).then(({ data }) => {
  const $ = cheerio.load(data);
  const rows = $("tr");

  const results = [];

  rows.each((_, tr) => {
    const cols = $(tr).find("td");
    if (cols.length >= 3) {
      const scientific = $(cols[1]).text().trim();
      const common = $(cols[2]).text().trim();
      if (scientific && common && scientific.toLowerCase() !== "species") {
        results.push({ scientific, common });
      }
    }
  });

  // write output
  fs.writeFileSync("turtle_names.json", JSON.stringify(results, null, 2));
  console.log("Saved", results.length, "pairs!");
});