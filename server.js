const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3939;

const KBO_BASE   = 'https://www.koreabaseball.com';
const NAVER_BASE = 'https://api-gw.sports.naver.com';
const HEADERS  = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Referer': KBO_BASE + '/',
};
const NAVER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    'Origin':  'https://m.sports.naver.com',
    'Referer': 'https://m.sports.naver.com/',
};

const TEAMS = [
    { id: 'KT', name: 'KT',   color: '#000000' },
    { id: 'SS', name: '삼성', color: '#1f3fce' },
    { id: 'LG', name: 'LG',   color: '#c30452' },
    { id: 'HT', name: 'KIA',  color: '#ea0029' },
    { id: 'OB', name: '두산', color: '#070084' },
    { id: 'NC', name: 'NC',   color: '#1c5da4' },
    { id: 'SK', name: 'SSG',  color: '#ce0e2d' },
    { id: 'HH', name: '한화', color: '#ff5500' },
    { id: 'LT', name: '롯데', color: '#002b5b' },
    { id: 'WO', name: '키움', color: '#570514' },
];

const TEAM_MAP    = Object.fromEntries(TEAMS.map(t => [t.id, t]));
const NAME_TO_CODE = Object.fromEntries(TEAMS.map(t => [t.name, t.id]));

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6시간
const _cache = new Map();
function getCached(key) {
    const e = _cache.get(key);
    if (!e || Date.now() - e.t > CACHE_TTL) { _cache.delete(key); return null; }
    return e.d;
}
function setCache(key, data) { _cache.set(key, { d: data, t: Date.now() }); }

async function fetchGameInfo(gameId) {
    try {
        const { data } = await axios.get(
            `${NAVER_BASE}/schedule/games/${gameId}`,
            { headers: NAVER_HEADERS, timeout: 5000 }
        );
        const g = data.result?.game;
        if (!g) return null;
        return {
            winPitcher:   g.winPitcherName    || null,
            losePitcher:  g.losePitcherName   || null,
            awayStarter:  g.awayStarterName   || null,
            homeStarter:  g.homeStarterName   || null,
        };
    } catch {
        return null;
    }
}

// 날짜(YYYY-MM-DD) 기준 Naver 일정에서 해당 경기의 gameId 조회
async function fetchNaverGameId(dateStr, awayName, homeName) {
    try {
        const { data } = await axios.get(
            `${NAVER_BASE}/schedule/games?categoryId=kbo&date=${dateStr}`,
            { headers: NAVER_HEADERS, timeout: 5000 }
        );
        const match = (data.result?.games || []).find(
            g => g.awayTeamName === awayName && g.homeTeamName === homeName
        );
        return match?.gameId || null;
    } catch {
        return null;
    }
}

app.use(express.static(path.join(__dirname, 'public')));

// ── 팀 엠블럼 이미지 프록시 ───────────────────────────────
app.get('/api/emblem/:teamCode', async (req, res) => {
    try {
        const url = `https://sports-phinf.pstatic.net/team/kbo/default/${req.params.teamCode}.png`;
        const { data, headers } = await axios.get(url, {
            headers: { ...NAVER_HEADERS },
            responseType: 'arraybuffer',
            timeout: 5000,
        });
        res.set('Content-Type', headers['content-type'] || 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(data);
    } catch (e) {
        res.status(404).end();
    }
});

// ── Helper: GET → VIEWSTATE → POST with team filter ───────
async function fetchWithTeamFilter(pageUrl, teamId) {
    // Step 1: GET → extract VIEWSTATE + session cookie
    const getResp = await axios.get(pageUrl, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(getResp.data);

    // Capture Set-Cookie for the POST (ASP.NET_SessionId is required)
    const cookies = (getResp.headers['set-cookie'] || [])
        .map(c => c.split(';')[0])
        .join('; ');

    const TEAM_F   = 'ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ddlTeam$ddlTeam';
    const SEASON_F = 'ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ddlSeason$ddlSeason';
    const SERIES_F = 'ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$ddlSeries$ddlSeries';

    const post = {};
    $('input[type="hidden"]').each((_, el) => {
        const name = $(el).attr('name');
        if (name) post[name] = $(el).val() || '';
    });
    post['__EVENTTARGET']   = TEAM_F;
    post['__EVENTARGUMENT'] = '';
    post[TEAM_F]   = teamId;
    post[SEASON_F] = '2026';
    post[SERIES_F] = '0';

    // Step 2: POST with session cookie
    const encoded = Object.entries(post)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');

    const { data: postHtml } = await axios.post(pageUrl, encoded, {
        headers: {
            ...HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': pageUrl,
            'Cookie': cookies,
        },
        timeout: 15000,
    });

    return postHtml;
}

// ── Helper: parse tData01 table ───────────────────────────
function parseStatsTable(html, type = 'hitter') {
    const $ = cheerio.load(html);
    const headers = [];
    $('table.tData01 thead th').each((_, el) => headers.push($(el).text().trim()));

    const players = [];
    $('table.tData01 tbody tr').each((_, row) => {
        const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();
        if (cells.length >= 3) {
            const p = {};
            headers.forEach((h, i) => { p[h] = cells[i] || '-'; });
            const link = $(row).find('a').attr('href') || '';
            const m = link.match(/playerId=(\d+)/);
            if (m) p._playerId = m[1];
            p._type = type;
            players.push(p);
        }
    });

    return { headers, players };
}

// ── Helper: fetch backnum for players (캐시 적용) ─────────
const backnumCache = new Map();
async function fetchBacknums(players) {
    const needFetch = players.filter(p => p._playerId && !backnumCache.has(p._playerId));
    await Promise.all(needFetch.map(async p => {
        try {
            const detailPath = p._type === 'pitcher'
                ? 'PitcherDetail' : 'HitterDetail';
            const url = `${KBO_BASE}/Record/Player/${detailPath}/Basic.aspx?playerId=${p._playerId}`;
            const { data } = await axios.get(url, { headers: HEADERS, timeout: 8000 });
            const m = data.match(/lblBackNo">(\d+)</);
            backnumCache.set(p._playerId, m ? m[1] : '-');
        } catch { backnumCache.set(p._playerId, '-'); }
    }));
    return players.map(p => ({
        ...p,
        등번호: p._playerId ? (backnumCache.get(p._playerId) || '-') : '-',
    }));
}

// ── Teams ─────────────────────────────────────────────────
app.get('/api/teams', (_, res) => res.json(TEAMS));

// ── Standings (네이버 API) ─────────────────────────────────
app.get('/api/standings', async (_, res) => {
    try {
        const { data } = await axios.get(
            `${NAVER_BASE}/statistics/categories/kbo/seasons/2026/teams`,
            { headers: NAVER_HEADERS, timeout: 10000 }
        );
        const teams = (data.result?.seasonTeamStats || []).sort((a, b) => a.ranking - b.ranking);
        const standings = teams.map(t => ({
            rank:     String(t.ranking),
            teamName: t.teamName,
            emblem:   t.teamId ? `/api/emblem/${t.teamId}` : '',
            g:        String(t.gameCount),
            w:        String(t.winGameCount),
            l:        String(t.loseGameCount),
            d:        String(t.drawnGameCount),
            pct:      t.wra?.toFixed(3) || '-',
            gb:       t.gameBehind === 0 ? '-' : String(t.gameBehind),
            streak:   t.continuousGameResult || '',
            last5:    t.lastFiveGames || '',
        }));
        res.json(standings);
    } catch (e) {
        console.error('[standings]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Schedule ──────────────────────────────────────────────
app.get('/api/schedule', async (req, res) => {
    try {
        const now    = new Date();
        const year   = Number(req.query.year  || now.getFullYear());
        const month  = Number(req.query.month || now.getMonth() + 1);
        const teamId = req.query.teamId || 'HH';

        const { data } = await axios.post(
            `${KBO_BASE}/ws/Schedule.asmx/GetScheduleList`,
            `leId=1&srIdList=0&seasonId=${year}&gameMonth=${month}&teamId=${teamId}`,
            {
                headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
                timeout: 10000,
            }
        );

        const teamName = TEAM_MAP[teamId]?.name || '';
        const parsed = (data.rows || []).map(r => parseGame(r.row, teamName, year));

        const games = await Promise.all(parsed.map(async g => {
            if (!g.gameId) return g;
            const info = await fetchGameInfo(g.gameId).catch(() => null);
            return info ? { ...g, ...info } : g;
        }));

        res.json({ year, month, teamId, games });
    } catch (e) {
        console.error('[schedule]', e.message);
        res.status(500).json({ error: e.message });
    }
});

function parseGame(cells, teamName, year) {
    const date    = (cells[0]?.Text || '').trim();
    const time    = (cells[1]?.Text || '').replace(/<[^>]+>/g, '').trim();
    const mHtml   = cells[2]?.Text || '';
    const stadium = (cells[7]?.Text || '').trim();

    const $ = cheerio.load(mHtml);
    const spans = [];
    $('span').each((_, el) => spans.push({ text: $(el).text().trim(), cls: $(el).attr('class') || '' }));

    const teams  = spans.filter(s => s.text && !s.text.match(/^\d+$/) && s.text !== 'vs');
    const scores = spans.filter(s => s.text.match(/^\d+$/));

    const away = teams[0]?.text || '';
    const home = teams[1]?.text || '';
    const aS   = scores[0] ? { v: +scores[0].text, cls: scores[0].cls } : null;
    const hS   = scores[1] ? { v: +scores[1].text, cls: scores[1].cls } : null;
    // KBO 클래스: win / lose / same(무승부)
    // 단, 경기 전에도 0:0에 same을 붙이므로 → 점수 중 하나라도 0보다 커야 진짜 종료
    const anyScorePositive = (aS?.v > 0) || (hS?.v > 0);
    const hasWinLose = spans.some(s => s.cls === 'win' || s.cls === 'lose');
    const hasSame    = spans.some(s => s.cls === 'same');
    const done       = hasWinLose || (hasSame && anyScorePositive);
    const inProgress = !done && scores.length > 0 && anyScorePositive;

    let result = null;
    if (done) {
        if (away === teamName)      result = aS?.cls === 'win' ? 'W' : aS?.cls === 'same' ? 'D' : 'L';
        else if (home === teamName) result = hS?.cls === 'win' ? 'W' : hS?.cls === 'same' ? 'D' : 'L';
    }

    // gameId 형식: YYYYMMDD{awayCode}{homeCode}0{YEAR} — 완료 여부 무관하게 생성
    let gameId = null;
    if (date && away && home) {
        const awayCode = NAME_TO_CODE[away];
        const homeCode = NAME_TO_CODE[home];
        if (awayCode && homeCode) {
            const y = year || new Date().getFullYear();
            const mmdd = date.replace(/[^0-9]/g, ''); // "09.01(화)" → "0901"
            gameId = `${y}${mmdd}${awayCode}${homeCode}0${y}`;
        }
    }

    return { date, time, away, home, awayScore: aS?.v ?? null, homeScore: hS?.v ?? null, stadium, completed: done, inProgress, result, isHome: home === teamName, gameId };
}

// ── Today's games (네이버 API) ────────────────────────────
app.get('/api/today', async (req, res) => {
    try {
        const now  = new Date();
        const yyyy = now.getFullYear();
        const mm   = String(now.getMonth() + 1).padStart(2, '0');
        const dd   = String(now.getDate()).padStart(2, '0');
        const date = `${yyyy}-${mm}-${dd}`;

        const { data } = await axios.get(
            `${NAVER_BASE}/schedule/games?categoryId=kbo&date=${date}`,
            { headers: NAVER_HEADERS, timeout: 10000 }
        );

        const DONE = new Set(['FINAL', 'RESULT', 'POSTPONE']);
        const rawGames = (data.result?.games || []).map(g => ({
            gameId:    g.gameId,
            time:      g.gameDateTime ? g.gameDateTime.slice(11, 16) : '',
            away:      g.awayTeamName,
            home:      g.homeTeamName,
            awayScore: g.awayTeamScore,
            homeScore: g.homeTeamScore,
            awayEmblem: g.awayTeamCode ? `/api/emblem/${g.awayTeamCode}` : '',
            homeEmblem: g.homeTeamCode ? `/api/emblem/${g.homeTeamCode}` : '',
            stadium:      g.stadium || '',
            status:       DONE.has(g.statusCode) ? 'FINAL' : g.statusCode,
            statusInfo:   g.statusInfo,
            winner:       g.winner,
            homeTeamCode: g.homeTeamCode || '',
        }));

        const games = await Promise.all(rawGames.map(async g => {
            if (g.status !== 'FINAL') return g;
            const info = await fetchGameInfo(g.gameId);
            return { ...g, ...info };
        }));

        res.json(games);
    } catch (e) {
        console.error('[today]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Game detail (linescore) ───────────────────────────────
app.get('/api/game/:gameId', async (req, res) => {
    try {
        const { data } = await axios.get(
            `${NAVER_BASE}/schedule/games/${req.params.gameId}`,
            { headers: NAVER_HEADERS, timeout: 8000 }
        );
        const g = data.result?.game;
        if (!g) return res.status(404).json({ error: 'not found' });

        res.json({
            gameId:    g.gameId,
            away:      g.awayTeamName,
            home:      g.homeTeamName,
            awayInnings: g.awayTeamScoreByInning || [],
            homeInnings: g.homeTeamScoreByInning || [],
            awayRheb:  g.awayTeamRheb || [],
            homeRheb:  g.homeTeamRheb || [],
            winPitcher:  g.winPitcherName || null,
            losePitcher: g.losePitcherName || null,
            statusCode:  g.statusCode,
            currentInning: g.currentInning || '',
        });
    } catch (e) {
        console.error('[game]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Game preview (선발투수 전력분석) ──────────────────────
app.get('/api/preview/:gameId', async (req, res) => {
    try {
        const cacheKey = `preview:${req.params.gameId}`;
        const cached = getCached(cacheKey);
        if (cached) return res.json(cached);

        const { data } = await axios.get(
            `${NAVER_BASE}/schedule/games/${req.params.gameId}/preview`,
            { headers: NAVER_HEADERS, timeout: 10000 }
        );
        const p = data.result?.previewData;
        if (!p) return res.status(404).json({ error: 'no preview' });

        const pitKindLabel = { FAST:'직구', SLID:'슬라이더', FORK:'포크', CURV:'커브', CHUP:'체인지업', SINKER:'싱커', CUTT:'커터', TWOS:'투심' };

        const mapStarter = (s) => s ? {
            name:        s.playerInfo?.name,
            backnum:     s.playerInfo?.backnum,
            hitType:     s.playerInfo?.hitType,
            season: {
                era:   s.currentSeasonStats?.era,
                w:     s.currentSeasonStats?.w,
                l:     s.currentSeasonStats?.l,
                inn:   s.currentSeasonStats?.inn2 || s.currentSeasonStats?.inn,
                kk:    s.currentSeasonStats?.kk,
                whip:  s.currentSeasonStats?.whip,
            },
            vsOpponent: {
                era:  s.currentSeasonStatsOnOpponents?.era,
                g:    s.currentSeasonStatsOnOpponents?.gameCount,
                inn:  s.currentSeasonStatsOnOpponents?.inn,
                w:    s.currentSeasonStatsOnOpponents?.w,
                l:    s.currentSeasonStatsOnOpponents?.l,
            },
            pitKinds: (s.currentPitKindStats || []).map(pk => ({
                label: pitKindLabel[pk.type] || pk.type,
                rate:  Math.round(pk.pit_rt),
                speed: pk.speed,
            })),
        } : null;

        const result = {
            awayStarter: mapStarter(p.awayStarter),
            homeStarter: mapStarter(p.homeStarter),
            seasonVs:    p.seasonVsResult,
            gameInfo:    p.gameInfo,
        };
        setCache(cacheKey, result);
        res.json(result);
    } catch (e) {
        console.error('[preview]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── YouTube highlight (RSS 방식) ──────────────────────────
const TVING_CHANNEL_ID = 'UC8JtQf77wqhVpOQ8Cze8JjA';
let rssCache = { data: null, t: 0 };

async function fetchTvingRss() {
    if (rssCache.data && Date.now() - rssCache.t < 30 * 60 * 1000) return rssCache.data;
    const { data } = await axios.get(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${TVING_CHANNEL_ID}`,
        { timeout: 8000 }
    );
    rssCache = { data, t: Date.now() };
    return data;
}

app.get('/api/highlight', async (req, res) => {
    try {
        const { gameId, away, home } = req.query;
        if (!gameId || !away || !home) return res.status(400).json({ error: 'missing params' });

        const dateStr = gameId.slice(0, 8);
        const m = parseInt(dateStr.slice(4, 6), 10);
        const d = parseInt(dateStr.slice(6, 8), 10);
        const dateLabel = `${m}/${d}`;   // "9/17"

        const xml = await fetchTvingRss();

        // <entry> 블록마다 videoId + title 추출
        const entries = [...xml.matchAll(/<yt:videoId>([^<]+)<\/yt:videoId>[\s\S]*?<title>([^<]+)<\/title>/g)];
        const match = entries.find(([, , title]) =>
            title.includes(dateLabel) &&
            (title.includes(away) || title.includes(home))
        );

        const videoId = match ? match[1] : null;
        const title   = match ? match[2] : null;
        res.json({ videoId, title });
    } catch (e) {
        console.error('[highlight]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Hitters ───────────────────────────────────────────────
app.get('/api/hitters', async (req, res) => {
    try {
        const teamId = req.query.teamId || 'HH';
        const html = await fetchWithTeamFilter(`${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx`, teamId);
        const result = parseStatsTable(html, 'hitter');
        result.players = await fetchBacknums(result.players);
        res.json(result);
    } catch (e) {
        console.error('[hitters]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Pitchers ──────────────────────────────────────────────
app.get('/api/pitchers', async (req, res) => {
    try {
        const teamId = req.query.teamId || 'HH';
        const html = await fetchWithTeamFilter(`${KBO_BASE}/Record/Player/PitcherBasic/Basic1.aspx`, teamId);
        const result = parseStatsTable(html, 'pitcher');
        result.players = await fetchBacknums(result.players);
        res.json(result);
    } catch (e) {
        console.error('[pitchers]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n⚾  KBO 대시보드  →  http://localhost:${PORT}\n`);
});
