// vidsrc.js
const cheerio = require('cheerio');
const { decrypt } = require('./helpers/decoder');

let BASEDOM = "https://whisperingauroras.com";

async function serversLoad(html) {
  const $ = cheerio.load(html);
  const servers = [];
  const title = $("title").text() ?? "";
  const base = $("iframe").attr("src") ?? "";
  BASEDOM = new URL(base.startsWith("//") ? "https:" + base : base).origin ?? BASEDOM;
  $(".serversList .server").each((index, element) => {
    const server = $(element);
    servers.push({ name: server.text().trim(), dataHash: server.attr("data-hash") ?? null });
  });
  return { servers, title };
}

async function PRORCPhandler(prorcp) {
  const prorcpFetch = await fetch(`${BASEDOM}/prorcp/${prorcp}`);
  const prorcpResponse = await prorcpFetch.text();
  const scripts = prorcpResponse.match(/<script\s+src="\/([^"]*\.js)\?\_=([^"]*)"><\/script>/gm);
  if (!scripts) return null;
  
  const script = (scripts[scripts.length - 1].includes("cpt.js"))
    ? scripts[scripts.length - 2].replace(/.*src="\/([^"]*\.js)\?\_=([^"]*)".*/, "$1?_=$2")
    : scripts[scripts.length - 1].replace(/.*src="\/([^"]*\.js)\?\_=([^"]*)".*/, "$1?_=$2");
    
  const jsFileReq = await fetch(`${BASEDOM}/${script}`, {
    headers: { "accept": "*/*", "Referer": `${BASEDOM}/` },
    method: "GET",
  });
  const jsCode = await jsFileReq.text();
  const decryptRegex = /{}\}window\[([^"]+)\("([^"]+)"\)/;
  const decryptMatches = jsCode.match(decryptRegex);
  
  const $ = cheerio.load(prorcpResponse);
  if (!decryptMatches || decryptMatches?.length < 3) return null;
  
  const id = decrypt(decryptMatches[2].toString().trim(), decryptMatches[1].toString().trim());
  const data = $("#" + id);
  const result = await decrypt(await data.text(), decryptMatches[2].toString().trim());
  return result;
}

async function rcpGrabber(html) {
  const regex = /src:\s*'([^']*)'/;
  const match = html.match(regex);
  if (!match) return null;
  return { metadata: { image: "" }, data: match[1] };
}

async function tmdbScrape(tmdbId, type, season, episode) {
  const url = (type === "movie")
    ? `https://vidsrc.net/embed/${type}?tmdb=${tmdbId}`
    : `https://vidsrc.net/embed/${type}?tmdb=${tmdbId}&season=${season}&episode=${episode}`;
    
  const embed = await fetch(url);
  const embedResp = await embed.text();
  const { servers, title } = await serversLoad(embedResp);
  
  const rcpFetchPromises = servers.map(element => fetch(`${BASEDOM}/rcp/${element.dataHash}`));
  const rcpResponses = await Promise.all(rcpFetchPromises);
  const prosrcrcp = await Promise.all(rcpResponses.map(async (response) => rcpGrabber(await response.text())));

  const apiResponse = [];
  for (const item of prosrcrcp) {
    if (!item) continue;
    if (item.data.substring(0, 8) === "/prorcp/") {
      apiResponse.push({
        name: title,
        mediaId: tmdbId,
        stream: await PRORCPhandler(item.data.replace("/prorcp/", "")),
        referer: BASEDOM,
      });
    }
  }
  return apiResponse;
}

module.exports = tmdbScrape;
