const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outFile = path.join(root, 'data', 'raw', 'cloud_live_log.jsonl');
const keyFile = path.join(root, 'data', 'raw', '.seoul_key');
const SEOUL_KEY = process.env.SEOUL_API_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');

function fetchJson(url) {
  return new Promise(resolve => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'OlParkFlowCollector/1.0' }, timeout: 12000 }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); }
        catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function avgSpd(list) {
  if (!list.length) return null;
  const spd = +(list.reduce((s, r) => s + Number(r.SPD || 0), 0) / list.length).toFixed(1);
  return { spd, idx: spd <= 15 ? '정체' : spd <= 25 ? '서행' : '원활' };
}

(async () => {
  const ts = Date.now();
  const kst = new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 19);
  const record = { ts, kst, parkingSum: null, temp: null, precip: null, roadAvg: null, gateRoads: null, crowd: null, jamsilAvail: null };

  const [pk, wx, ol, js] = await Promise.all([
    fetchJson('https://www.ksponco.or.kr/online/main/parkingorsApi.do?apiKey=PARKING21803504&_=' + ts),
    fetchJson('https://api.open-meteo.com/v1/forecast?latitude=37.5207&longitude=127.1227&current=temperature_2m,precipitation&timezone=Asia%2FSeoul'),
    SEOUL_KEY ? fetchJson(`http://openapi.seoul.go.kr:8088/${SEOUL_KEY}/json/citydata/1/5/${encodeURIComponent('올림픽공원')}`) : Promise.resolve(null),
    SEOUL_KEY ? fetchJson(`http://openapi.seoul.go.kr:8088/${SEOUL_KEY}/json/citydata/1/5/${encodeURIComponent('잠실 관광특구')}`) : Promise.resolve(null)
  ]);

  if (Array.isArray(pk) && pk[0] && typeof pk[0].parking_sum !== 'undefined') record.parkingSum = Number(pk[0].parking_sum);
  if (wx?.current) { record.temp = wx.current.temperature_2m; record.precip = wx.current.precipitation; }

  const cOl = ol?.CITYDATA;
  if (cOl) {
    const lp = cOl.LIVE_PPLTN_STTS?.[0];
    if (lp) {
      record.crowd = {
        lvl: lp.AREA_CONGEST_LVL,
        min: Number(lp.AREA_PPLTN_MIN || 0),
        max: Number(lp.AREA_PPLTN_MAX || 0),
        age1020: +((Number(lp.PPLTN_RATE_10 || 0) + Number(lp.PPLTN_RATE_20 || 0)).toFixed(1)),
        age4060: +((Number(lp.PPLTN_RATE_40 || 0) + Number(lp.PPLTN_RATE_50 || 0) + Number(lp.PPLTN_RATE_60 || 0)).toFixed(1))
      };
    }
    const rAvg = cOl.ROAD_TRAFFIC_STTS?.AVG_ROAD_DATA;
    if (rAvg) record.roadAvg = { spd: Number(rAvg.ROAD_TRAFFIC_SPD || 0), idx: rAvg.ROAD_TRAFFIC_IDX };
    const links = cOl.ROAD_TRAFFIC_STTS?.ROAD_TRAFFIC_STTS || [];
    record.gateRoads = {
      north2: avgSpd(links.filter(r => (r.END_ND_NM || '').includes('북2문'))),
      east2: avgSpd(links.filter(r => (r.END_ND_NM || '').includes('동문교차로'))),
      south2: avgSpd(links.filter(r => (r.END_ND_NM || '').includes('남2문'))),
      west: avgSpd(links.filter(r => (r.END_ND_NM || '').includes('남4문') || (r.ROAD_NM === '올림픽로' && (r.END_ND_NM || '').includes('올림픽공원앞교차로'))))
    };
  }
  const cJs = js?.CITYDATA;
  if (cJs && Array.isArray(cJs.PRK_STTS)) {
    const jam = cJs.PRK_STTS.find(p => (p.PRK_NM || '').includes('잠실역') && p.CUR_PRK_YN === 'Y');
    if (jam) record.jamsilAvail = Math.max(0, Number(jam.CPCTY || 357) - Number(jam.CUR_PRK_CNT || 0));
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.appendFileSync(outFile, JSON.stringify(record) + '\n', 'utf8');
  console.log('Collected:', JSON.stringify(record));
})();
