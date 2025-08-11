/**
 * 作業カフェマップ：GASサーバー側
 * - Google Places 失敗時に Overpass API (OSM) へフォールバック
 * - 投票（attrs/votes）管理は従来通り
 */

const SHEET_NAME_ATTRS = 'attrs';      // 集計シート
const SHEET_NAME_VOTES = 'votes';      // 投票明細
const RADIUS_METERS_DEFAULT = 1500;    // 1.5km 検索半径
const VOTE_COOLDOWN_MINUTES = 5;       // 同一(clientId/place/attr)の投票間隔
const PROP_SHEET_ID = 'SHEET_ID';      // 永続化するスプレッドシートID

function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('作業カフェマップ')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('PLACES_API_KEY');
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  let sheetId = props.getProperty(PROP_SHEET_ID);
  if (sheetId) {
    try { return SpreadsheetApp.openById(sheetId); } catch (e) {}
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    props.setProperty(PROP_SHEET_ID, active.getId());
    return active;
  }
  const ss = SpreadsheetApp.create('CafeMapData');
  props.setProperty(PROP_SHEET_ID, ss.getId());
  return ss;
}

function ensureSheets_() {
  const ss = getSpreadsheet_();
  let attrs = ss.getSheetByName(SHEET_NAME_ATTRS);
  if (!attrs) {
    attrs = ss.insertSheet(SHEET_NAME_ATTRS);
    attrs.appendRow(['place_id','name','wifi','power','updated_at','wifi_yes','wifi_no','power_yes','power_no']);
  }
  let votes = ss.getSheetByName(SHEET_NAME_VOTES);
  if (!votes) {
    votes = ss.insertSheet(SHEET_NAME_VOTES);
    votes.appendRow(['ts','client_id','place_id','name','attr','value']);
  }
  return { ss, attrs, votes };
}

function getSheetUrl() { return getSpreadsheet_().getUrl(); }

// --- Data sources ------------------------------------------------------------

function searchPlaces(lat, lng, radius) {
  const r = Math.max(200, Math.min(Number(radius||RADIUS_METERS_DEFAULT), 5000));
  const res1 = tryGooglePlaces_(lat, lng, r);
  if (res1.ok && res1.items.length) {
    const attrs = getAttrs(res1.items.map(d => d.place_id));
    return res1.items.map(d => ({ ...d, attrs: attrs[d.place_id] || null }));
  }
  const res2 = tryOverpass_(lat, lng, r);
  const attrs = getAttrs(res2.items.map(d => d.place_id));
  const merged = res2.items.map(d => ({ ...d, attrs: attrs[d.place_id] || null }));
  if ((!res1.ok) && res1.error) merged.unshift({
    place_id: 'diagnostic', name: `【診断】Places失敗: ${res1.error}`,
    lat, lng, address: '', open_now: null, rating: null, user_ratings_total: null, types: ['diagnostic']
  });
  return merged;
}

function tryGooglePlaces_(lat, lng, radius){
  const out = { ok:false, items:[], error:null };
  const key = getApiKey_();
  if (!key) { out.error = 'PLACES_API_KEY 未設定'; return out; }
  const urlCafe = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=cafe&language=ja&region=jp&key=${key}`;
  const urlLib  = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=library&language=ja&region=jp&key=${key}`;
  try {
    const results = [];
    [urlCafe, urlLib].forEach(u => {
      const res = UrlFetchApp.fetch(u, { muteHttpExceptions: true });
      const json = JSON.parse(res.getContentText());
      if (json.status === 'OK' || json.status === 'ZERO_RESULTS') {
        (json.results||[]).forEach(p => results.push({
          place_id: p.place_id,
          name: p.name,
          lat: p.geometry?.location?.lat ?? null,
          lng: p.geometry?.location?.lng ?? null,
          address: p.vicinity || '',
          open_now: p.opening_hours ? p.opening_hours.open_now : null,
          rating: p.rating || null,
          user_ratings_total: p.user_ratings_total || null,
          types: p.types || []
        }));
      } else {
        out.error = json.status + (json.error_message? `: ${json.error_message}`:'');
      }
    });
    const seen = new Set();
    out.items = results.filter(r => r.lat && r.lng && (seen.has(r.place_id) ? false : seen.add(r.place_id)));
    out.ok = true;
  } catch(e){ out.error = e && e.message ? e.message : String(e); }
  return out;
}

function tryOverpass_(lat, lng, radius){
  const out = { ok:false, items:[], error:null };
  // around: 半径m, amenity=cafe/library をノード/ウェイ/リレーから取得
  const q = `[
    out:json][timeout:25];
    (
      node["amenity"="cafe"](around:${radius},${lat},${lng});
      node["amenity"="library"](around:${radius},${lat},${lng});
      way["amenity"="cafe"](around:${radius},${lat},${lng});
      way["amenity"="library"](around:${radius},${lat},${lng});
      rel["amenity"="cafe"](around:${radius},${lat},${lng});
      rel["amenity"="library"](around:${radius},${lat},${lng});
    );
    out center 60;`;
  const url = 'https://overpass-api.de/api/interpreter';
  try {
    const res = UrlFetchApp.fetch(url, { method:'post', payload:{ data:q }, muteHttpExceptions:true });
    const json = JSON.parse(res.getContentText());
    const items = (json.elements||[]).map(el => {
      const latlon = el.type === 'node' ? { lat: el.lat, lng: el.lon } : { lat: el.center?.lat, lng: el.center?.lon };
      const name = el.tags?.name || (el.tags?.['name:ja'] || '名称不明');
      const address = [el.tags?.addr2, el.tags?.addr1, el.tags?.addr, el.tags?.['addr:full']].find(Boolean) || '';
      const pid = `osm_${el.type}_${el.id}`;
      return { place_id: pid, name, lat: latlon.lat, lng: latlon.lng, address, open_now: null, rating: null, user_ratings_total: null, types: ['osm', el.tags?.amenity].filter(Boolean) };
    }).filter(x => x.lat && x.lng);
    out.items = items;
    out.ok = true;
  } catch(e){ out.error = e && e.message ? e.message : String(e); }
  return out;
}

// --- Attrs / Votes -----------------------------------------------------------

function getAttrs(placeIds) {
  const { attrs } = ensureSheets_();
  const values = attrs.getDataRange().getValues();
  if (!values || values.length <= 1) return {};
  values.shift();
  const map = {};
  values.forEach(row => {
    const [place_id, name, wifi, power, updated_at, wifi_yes, wifi_no, power_yes, power_no] = row;
    if (placeIds && placeIds.length && !placeIds.includes(place_id)) return;
    map[place_id] = {
      name, wifi, power, updated_at,
      wifi_yes: Number(wifi_yes || 0),
      wifi_no: Number(wifi_no || 0),
      power_yes: Number(power_yes || 0),
      power_no: Number(power_no || 0)
    };
  });
  return map;
}

function submitAttr(payload) {
  // payload: { clientId, place_id, name, attr: 'wifi'|'power', value: true|false }
  if (!payload || !payload.place_id || !payload.attr) throw new Error('Invalid payload');
  const { attrs, votes } = ensureSheets_();

  const now = new Date();
  const vRange = votes.getDataRange().getValues();
  if (vRange && vRange.length > 1) {
    vRange.shift();
    for (let i = vRange.length - 1; i >= 0 && i >= vRange.length - 500; i--) {
      const [ts, client_id, place_id, _name, attr, _value] = vRange[i] || [];
      if (!ts) continue;
      if (client_id === payload.clientId && place_id === payload.place_id && attr === payload.attr) {
        const diffMin = (now - new Date(ts)) / 60000;
        if (diffMin < VOTE_COOLDOWN_MINUTES) {
          const cur = getAttrs([payload.place_id])[payload.place_id] || null;
          return { ok: false, reason: `直近${VOTE_COOLDOWN_MINUTES}分以内の同一投票はできません`, attrs: cur };
        }
        break;
      }
    }
  }

  votes.appendRow([now, payload.clientId || '', payload.place_id, payload.name || '', payload.attr, payload.value === true]);

  const aRange = attrs.getDataRange().getValues();
  let data = aRange && aRange.length ? aRange.slice(1) : [];
  let idx = data.findIndex(r => r[0] === payload.place_id);
  const toBoolText = (b) => (b === true ? 'yes' : (b === false ? 'no' : 'unknown'));

  if (idx < 0) {
    const row = [payload.place_id, payload.name || '', '', '', now, 0, 0, 0, 0];
    if (payload.attr === 'wifi') { row[2] = toBoolText(payload.value); row[5] = (payload.value ? 1 : 0); row[6] = (!payload.value ? 1 : 0); }
    else { row[3] = toBoolText(payload.value); row[7] = (payload.value ? 1 : 0); row[8] = (!payload.value ? 1 : 0); }
    attrs.appendRow(row);
  } else {
    const row = data[idx];
    if (payload.attr === 'wifi') { row[2] = toBoolText(payload.value); row[5] = Number(row[5]||0) + (payload.value?1:0); row[6] = Number(row[6]||0) + (!payload.value?1:0); }
    else { row[3] = toBoolText(payload.value); row[7] = Number(row[7]||0) + (payload.value?1:0); row[8] = Number(row[8]||0) + (!payload.value?1:0); }
    row[4] = now; attrs.getRange(idx + 2, 1, 1, row.length).setValues([row]);
  }

  const updated = getAttrs([payload.place_id])[payload.place_id] || null;
  return { ok: true, attrs: updated, sheetUrl: getSheetUrl() };
}
