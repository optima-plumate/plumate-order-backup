// 梅侍訂購意向頁 — 前端邏輯（無框架、無建置）
const FUNCTION_URL =
  "https://zeybladpvgilgefcpyjq.supabase.co/functions/v1/order-intent";

const DEV = ["localhost", "127.0.0.1", "0.0.0.0", ""].includes(location.hostname);

// 緊急備援表單（Google 表單，獨立於 Supabase/Cloudflare）：後端讀不到商品時自動導向
const BACKUP_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSehuzBLO9xzw8avJzv50fjuQwgMlpYz5DLqktATyEc5cgfD5Q/viewform";

// 團購：網址帶 ?g=團主代碼（例 ?g=mary-0701）即進入該團主的團購單；無此參數＝官網單
const GROUP = new URLSearchParams(location.search).get("g");
let groupHost = null; // { slug, name, open_at, close_at, status } 由後端回傳

/* ---------- 廣告來源歸因（UTM 全程保留） ---------- */
// 進站首觸抓 utm_*／點擊 ID，寫入 sessionStorage；之後站內跳轉洗掉網址 query 也讀得回來。
// 採「首觸不覆寫」（已存有值就不蓋），避免站內跳轉把來源洗成空。
const ATTR_KEY = "plumate_attr";
const ATTR_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"];
function getAttribution() {
  try { return JSON.parse(sessionStorage.getItem(ATTR_KEY) || "{}"); } catch (_) { return {}; }
}
function captureAttribution() {
  const stored = getAttribution();
  const qs = new URLSearchParams(location.search);
  let changed = false;
  for (const k of ATTR_FIELDS) {
    const v = qs.get(k);
    if (v && !stored[k]) { stored[k] = String(v).slice(0, 200); changed = true; } // 首觸不覆寫
  }
  if (!stored.landing_page) { stored.landing_page = (location.pathname + location.search).slice(0, 500); changed = true; }
  if (changed) { try { sessionStorage.setItem(ATTR_KEY, JSON.stringify(stored)); } catch (_) {} }
  return stored;
}
// 把保留的 UTM 附加到站內跳轉網址（解 §1.3：導頁不再洗掉來源）；已帶的參數不覆寫
function withAttribution(url) {
  try {
    const attr = getAttribution();
    const u = new URL(url, location.href);
    for (const k of ATTR_FIELDS) {
      if (attr[k] && !u.searchParams.has(k)) u.searchParams.set(k, attr[k]);
    }
    return u.toString();
  } catch (_) { return url; }
}
// 「表單送出成功」轉換事件；追蹤碼未載入（被擋/DEV）時安靜跳過，不影響送單
function trackLead(leadId) {
  // Meta Pixel Lead（🔴 必須在下面 gtag 的 early return 之前，否則 GA4 被擋時 Lead 也跟著不發）
  try { if (typeof fbq === "function") fbq("track", "Lead"); } catch (_) {}
  if (typeof gtag !== "function") return;
  const attr = getAttribution();
  gtag("event", "generate_lead", {
    utm_source: attr.utm_source || "(direct)",
    utm_medium: attr.utm_medium || "(none)",
    utm_campaign: attr.utm_campaign || "(none)",
    utm_content: attr.utm_content || "",
    utm_term: attr.utm_term || "",
    lead_id: leadId || "",
    group: GROUP || "organic",
  });
}
captureAttribution(); // 進站即首觸紀錄

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
const money = (n) => "$" + Number(n).toLocaleString("en-US");

// { large:[{name,spec,po,pd}], small:[...], boxes:[{name,kind,po,pd,contents?,label?}] }
let products = { promos: [], large: [], small: [], boxes: [] };

// 暫時缺貨公告（僅前端顯示用；商品仍可下單，不影響送單與計價）
// 用完/補貨後記得移除，否則會一直顯示過期日期
const STOCK_NOTICES = [
];
const stockNotice = (name, spec) =>
  STOCK_NOTICES.find((s) => s.name === name && s.spec === spec)?.badge || null;

/* ---------- 年齡 gate ---------- */
$("#ageYes").addEventListener("click", () => {
  $("#ageGate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  loadProducts();
});
$("#ageNo").addEventListener("click", () => {
  $("#ageGate").classList.add("hidden");
  $("#ageBlocked").classList.remove("hidden");
});

/* ---------- 贈品照片放大（滿額活動縮圖點擊） ---------- */
function openGiftLightbox(src, cap) {
  const box = $("#giftLightbox");
  if (!box) return;
  $("#glbImg").src = src;
  $("#glbImg").alt = cap || "";
  $("#glbCap").textContent = cap || "";
  box.classList.remove("hidden");
}
function closeGiftLightbox() {
  const box = $("#giftLightbox");
  if (!box) return;
  box.classList.add("hidden");
  $("#glbImg").src = "";
}
document.addEventListener("click", (e) => {
  const thumb = e.target.closest(".gp-thumb, .box-photo");
  if (thumb) { openGiftLightbox(thumb.dataset.full, thumb.dataset.cap); return; }
  if (e.target.closest("#giftLightbox")) closeGiftLightbox(); // 點遮罩或關閉鈕都收起
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeGiftLightbox(); });

/* ---------- 載入商品 ---------- */
function setItemsStatus(msg, kind = "") {
  const el = $("#itemsStatus");
  el.textContent = msg;
  el.className = "items-status" + (kind ? " " + kind : "");
}
const usable = (d) =>
  d && ((d.large || []).length || (d.small || []).length || (d.boxes || []).length);

async function loadProducts() {
  setItemsStatus("商品載入中…", "loading");
  let data = null;
  try {
    const qs = GROUP ? `&g=${encodeURIComponent(GROUP)}` : "";
    const res = await fetch(`${FUNCTION_URL}?action=products${qs}`);
    if (res.ok) data = await res.json();
  } catch (e) {
    console.error("載入商品失敗", e);
  }
  if (!usable(data) && DEV) {
    try {
      data = await (await fetch("products.sample.json")).json();
    } catch (_) {}
  }
  if (DEV) showDevBanner();

  if (usable(data)) {
    products = { promos: data.promos || [], large: data.large || [], small: data.small || [], boxes: data.boxes || [] };
    groupHost = data.host || (GROUP ? { slug: GROUP, status: "invalid" } : null);
    setItemsStatus("");
    buildCatalog();
    applyGroupUI();
  } else {
    setItemsStatus("", "");
    showBackupFallback();
  }
}

// 後端讀不到商品（Supabase 掛）→ 自動降級：收起無法用的表單，導向獨立的備援 Google 表單
function showBackupFallback() {
  const app = $("#app");
  let bar = document.getElementById("backupBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "backupBar";
    bar.className = "backup-bar";
    app.insertBefore(bar, app.firstChild);
  }
  bar.innerHTML =
    `<div class="bb-title">⚠️ 訂購系統維護中</div>` +
    `<div class="bb-msg">目前系統暫時無法載入，為免耽誤您的訂購，請改用<strong>備援訂購單</strong>填寫，專人會盡快與您聯繫。</div>` +
    `<a class="bb-cta" href="${BACKUP_FORM_URL}" target="_blank" rel="noopener noreferrer">前往備援訂購單 →</a>`;
  if ($("#orderForm")) $("#orderForm").style.display = "none";
  document.querySelectorAll(".hero-desc, .notice-pill, #bannerCarousel").forEach((el) => (el.style.display = "none"));
}

/* ---------- 目錄（三類可展開、每項數量 +/-） ---------- */
function priceInline(po, pd) {
  po = po ? Number(po) : null;
  pd = pd ? Number(pd) : null;
  if (!po && !pd) return "";
  if (po && pd && po !== pd)
    return `<span class="pl-orig">${money(po)}</span><span class="pl-disc">優惠 ${money(pd)}</span>`;
  return `<span class="pl-disc">${money(pd || po)}</span>`;
}

function stepperHTML(extraClass = "", attrs = "", max = 999) {
  return `<span class="stepper">
    <button type="button" class="step minus" aria-label="減">−</button>
    <input class="qty-input ${extraClass}" type="number" inputmode="numeric" min="0" max="${max}" value="0" readonly ${attrs} aria-label="數量" />
    <button type="button" class="step plus" aria-label="加">＋</button>
  </span>`;
}

function bottleRow(b, specLabel, showSpec) {
  const base = showSpec ? `${b.name}（${b.spec}）` : b.name;
  const nm = base + (b.medals ? ` ${b.medals}` : "");
  const notice = stockNotice(b.name, b.spec);
  const noticeHTML = notice ? ` <span class="stock-notice">${esc(notice)}</span>` : "";
  return `<div class="catalog-row" data-kind="bottle" data-name="${esc(b.name)}" data-spec="${esc(specLabel)}" data-pd="${b.pd ?? ""}">
    <div class="cr-info"><div class="cr-name">${esc(nm)}${noticeHTML}</div><div class="cr-price">${priceInline(b.po, b.pd)}</div></div>
    ${stepperHTML()}
  </div>`;
}

// 禮盒商品圖（key＝商品主檔 name；清掉某列就不顯示該盒的圖）。點圖沿用滿額贈的放大燈箱。
const BOX_IMAGES = {
  "中秋金銀禮盒": "assets/box-jinyin.jpg?v=1",
  "中秋《奔馬》典藏禮盒": "assets/box-benma.jpg?v=1",
  "長流-梅侍聯名禮盒": "assets/box-shuangma.webp?v=1",
  "250ml 精選6入獲獎組_v2": "assets/box-six-v2.webp?v=1",
};
// 大圖（整張置頂）——最新活動用
function boxPhotoHTML(name) {
  const img = BOX_IMAGES[name];
  if (!img) return "";
  return `<button type="button" class="box-photo" data-full="${esc(img)}" data-cap="${esc(name)}" aria-label="放大看${esc(name)}商品圖"><img src="${esc(img)}" alt="${esc(name)}" loading="lazy" /><span class="gp-zoom" aria-hidden="true">🔍</span></button>`;
}
// 小縮圖（靠左，沿用滿額贈 .gp-thumb 樣式）——禮盒組用
function boxThumbHTML(name) {
  const img = BOX_IMAGES[name];
  if (!img) return "";
  return `<button type="button" class="gp-thumb" data-full="${esc(img)}" data-cap="${esc(name)}" aria-label="放大看${esc(name)}商品圖"><img src="${esc(img)}" alt="${esc(name)}" loading="lazy" /><span class="gp-zoom" aria-hidden="true">🔍</span></button>`;
}

// 口味2選1禮盒：一張盒卡 + 每口味各自數量鈕。每個口味列本身即標準 .catalog-row（帶 data-flavor），
// 故購物車小計／已選徽章／驗證全部沿用現有機制；唯一特別處是收單時多帶 flavor（見 collectItems）。
function flavorBoxHTML(b, label, saveHTML, photo = "", headThumb = "") {
  const rows = b.flavors
    .map(
      (fv) => `<div class="catalog-row flavor-row" data-kind="box" data-name="${esc(label)}" data-flavor="${esc(fv)}" data-spec="" data-pd="${b.pd ?? ""}">
        <div class="cr-info"><div class="cr-name">・${esc(fv)}款</div></div>
        ${stepperHTML()}
      </div>`,
    )
    .join("");
  const desc = b.desc ? `<div class="box-desc"><b>內含：</b>${esc(b.desc)}</div>` : "";
  return `<div class="flavor-box">
    ${photo}
    <div class="flavor-box-head">${headThumb}<div class="cr-info"><div class="cr-name">${esc(label)}${saveHTML}</div><div class="cr-price">${priceInline(b.po, b.pd)}</div></div></div>
    <div class="fixed6-box">${desc}<div class="mix-hint">請選擇口味（可分別填數量）</div>${rows}</div>
  </div>`;
}

function boxRows() {
  let html = "";
  for (const b of products.boxes) {
    if (b.kind === "mix6") {
      html += mixBoxBlock();
      continue;
    }
    if (b.flavors && b.flavors.length) {
      html += flavorBoxHTML(b, b.label || b.name, "", "", boxThumbHTML(b.name));
      continue;
    }
    const label = b.label || b.name;
    html += `<div class="catalog-row" data-kind="box" data-name="${esc(label)}" data-spec="" data-pd="${b.pd ?? ""}">
      ${boxThumbHTML(b.name)}<div class="cr-info"><div class="cr-name">${esc(label)}</div><div class="cr-price">${priceInline(b.po, b.pd)}</div></div>
      ${stepperHTML()}
    </div>`;
    if (b.kind === "fixed6" && (b.contents || []).length)
      html += `<div class="fixed6-box"><div class="mix-hint">固定內含以下 6 款（不可更換）</div>${b.contents
        .map((n) => `<div class="fixed6-row">・${esc(n)}</div>`)
        .join("")}<div class="gift-line">🎁 加贈專屬提盒</div></div>`;
    else if (b.desc)
      html += `<div class="fixed6-box"><div class="box-desc"><b>內含：</b>${esc(b.desc)}</div></div>`;
  }
  return html;
}

// 最新活動：本檔期主打（禮盒／獲獎組），內含照禮盒組原樣顯示 + 立省 + 數量鈕
function promoRows() {
  let html = "";
  for (const b of products.promos) {
    const label = b.label || b.name;
    const save = b.po && b.pd ? ` <span class="combo-save">立省 ${money(b.po - b.pd)}</span>` : "";
    if (b.flavors && b.flavors.length) {
      html += flavorBoxHTML(b, label, save, boxPhotoHTML(b.name));
      continue;
    }
    html += boxPhotoHTML(b.name);
    html += `<div class="catalog-row" data-kind="box" data-name="${esc(label)}" data-spec="" data-pd="${b.pd ?? ""}">
      <div class="cr-info"><div class="cr-name">${esc(label)}${save}</div><div class="cr-price">${priceInline(b.po, b.pd)}</div></div>
      ${stepperHTML()}
    </div>`;
    if (b.kind === "fixed6" && (b.contents || []).length)
      html += `<div class="fixed6-box"><div class="mix-hint">固定內含以下 6 款（不可更換）</div>${b.contents
        .map((n) => `<div class="fixed6-row">・${esc(n)}</div>`)
        .join("")}<div class="gift-line">🎁 加贈專屬提盒</div></div>`;
    else if (b.desc)
      html += `<div class="fixed6-box"><div class="box-desc"><b>內含：</b>${esc(b.desc)}</div></div>`;
    else if ((b.contents || []).length)
      html += `<div class="fixed6-box"><div class="mix-hint">固定內含以下 ${b.contents.length} 款（不可更換）</div>${b.contents
        .map((n) => `<div class="fixed6-row">・${esc(n)}</div>`)
        .join("")}</div>`;
  }
  return html;
}

// 滿額贈設定（清空 GIFT_TIERS 就不顯示；標題固定「滿額活動」不放月份）
const GIFT_MONTH = "";
const GIFT_TIERS = [
  { min: 3000, gift: "梅侍質感梅酒杯（375ml）", img: "assets/gift-cup.png?v=1" },
  { min: 5000, gift: "梅侍小樣組（50ml×4瓶）", img: "assets/gift-mini4.jpg?v=1", note: "口味隨機出貨" },
  { min: 10000, gift: "長流美術館｜徐悲鴻聯名 典藏款茶梅酒 700ml×1", img: "assets/gift-xubeihong.png?v=1", note: "東方美人/凍頂烏龍 2種口味隨機出貨" },
];
function updateGiftPromo(amt) {
  const el = $("#giftPromo");
  if (!el) return;
  if (!GIFT_TIERS.length) { el.innerHTML = ""; return; }
  // 非累贈：只有「已達標的最高一階」是實際贈品；較低階已被取代、較高階待達標
  const reachedIdx = GIFT_TIERS.reduce((acc, t, i) => (amt >= t.min ? i : acc), -1);
  const tiers = GIFT_TIERS.map((t, i) => {
    let icon = "🎁", cls = "";
    if (i === reachedIdx) { icon = "✅"; cls = " hit"; }
    else if (i < reachedIdx) { icon = "▫"; cls = " superseded"; }
    const note = t.note ? ` <span class="gp-note">（${esc(t.note)}）</span>` : "";
    const thumb = t.img
      ? `<button type="button" class="gp-thumb" data-full="${esc(t.img)}" data-cap="${esc(t.gift)}" aria-label="放大看${esc(t.gift)}"><img src="${esc(t.img)}" alt="${esc(t.gift)}" loading="lazy" /><span class="gp-zoom" aria-hidden="true">🔍</span></button>`
      : "";
    return `<div class="gp-tier${cls}">${thumb}<span class="gp-tier-txt">${icon} 滿 <b>${money(t.min)}</b> 送 ${esc(t.gift)}${note}</span></div>`;
  }).join("");
  const next = GIFT_TIERS.find((t) => amt < t.min);
  let tip = "";
  if (reachedIdx < 0) {
    if (amt > 0 && next) tip = `<div class="gp-tip">再買 <b>${money(next.min - amt)}</b> 即可獲得「${esc(next.gift)}」</div>`;
  } else if (next) {
    tip = `<div class="gp-tip">目前可得「${esc(GIFT_TIERS[reachedIdx].gift)}」；再買 <b>${money(next.min - amt)}</b> 可升級為「${esc(next.gift)}」</div>`;
  } else {
    tip = `<div class="gp-tip">🎉 已達最高滿額贈「${esc(GIFT_TIERS[reachedIdx].gift)}」，將隨單附上！</div>`;
  }
  el.innerHTML = `<div class="gp-title">🎁 滿額活動（活動不累贈）</div>${tiers}${tip}`;
}

const mixFlavors = () => products.small.filter((b) => b.spec === "250ml");

function mixPanel() {
  const flavors = mixFlavors()
    .map(
      (f) => `
      <div class="mix-row">
        <span class="mix-name">${esc(f.name + (f.medals ? ` ${f.medals}` : ""))}<span class="mix-price">${priceInline(null, f.pd)}</span></span>
        ${stepperHTML("mix-q", `data-name="${esc(f.name)}" data-pd="${f.pd ?? ""}"`, 6)}
      </div>`,
    )
    .join("");
  return `<div class="mix-panel">
    <div class="mix-hint">湊滿 <b>6 瓶</b>（可重複同口味）</div>
    ${flavors}
    <div class="mix-counter">已選 <b class="mix-count">0</b> / 6 瓶<span class="mix-total"></span></div>
  </div>`;
}
function mixSlot(n) {
  return `<div class="mix-slot">
    <div class="mix-slot-head"><span class="mix-slot-no">第 ${n} 組</span><button type="button" class="mix-remove" aria-label="移除這組">移除</button></div>
    ${mixPanel()}
  </div>`;
}
function renumberMix() {
  document
    .querySelectorAll("#mixSlots .mix-slot .mix-slot-no")
    .forEach((el, i) => (el.textContent = `第 ${i + 1} 組`));
}
function mixBoxBlock() {
  return `<div class="mix-block">
    <div class="mix-block-title">自由混搭 6 入（自選）</div>
    <div class="gift-line">🎁 加贈專屬提盒</div>
    <div id="mixSlots">${mixSlot(1)}</div>
    <button type="button" class="btn-add-mix">＋ 再加一組（自選6入）</button>
  </div>`;
}

function buildCatalog() {
  const sec = (key, title, inner) => `
    <div class="cat-section" data-cat="${key}">
      <button type="button" class="cat-header">
        <span class="cat-title">${title}</span><span class="cat-badge"></span><span class="cat-arrow">▸</span>
      </button>
      <div class="cat-body hidden">${inner}</div>
    </div>`;
  $("#catalog").innerHTML =
    (products.promos.length ? sec("promos", "🎉 最新活動", promoRows()) : "") +
    sec("large", "大瓶 700ml", products.large.map((b) => bottleRow(b, "700ml", false)).join("")) +
    sec("small", "小瓶 250ml／300ml", products.small.map((b) => bottleRow(b, b.spec + "散裝", true)).join("")) +
    sec("box", "🥮 禮盒組_中秋超熱賣", boxRows());
  updateCartTotal();
  updateCatBadges();
}

/* ---------- 團購：頂部團主標頭 + 檔期鎖單 ---------- */
function fmtMD(iso) {
  try {
    return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric" }).format(new Date(iso));
  } catch (_) {
    return "";
  }
}
function applyGroupUI() {
  if (!GROUP) return; // 官網單：不顯示任何團購元素
  const host = groupHost || { slug: GROUP, status: "invalid" };
  const app = $("#app");
  let bar = document.getElementById("groupBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "groupBar";
    app.insertBefore(bar, app.firstChild);
  }
  const nameTitle = host.name ? `${esc(host.name)} 團購意向單` : "團購意向單";
  if (host.status === "open") {
    const closeStr = host.close_at ? fmtMD(host.close_at) : "";
    bar.className = "group-bar";
    bar.innerHTML =
      `<div class="gb-title">🛒 ${nameTitle}</div>` +
      `<div class="gb-sub">純意向收集 ｜ 開團至 ${esc(closeStr)} 止</div>`;
    document.title = `${host.name} 團購意向單｜梅侍 Plumate`;
  } else {
    const officialBtn = `<a class="gb-cta" href="${withAttribution("https://plumate-order.pages.dev/")}">前往官網訂購單 →</a>`;
    let msg, cta = "";
    if (host.status === "upcoming") {
      msg = `本團將於 ${esc(fmtMD(host.open_at))} 開團，敬請期待`;
    } else if (host.status === "closed") {
      msg = "本團已結束，感謝您的支持 🙏<br>仍想選購？歡迎前往官網訂購單";
      cta = officialBtn;
    } else {
      msg = "找不到這個團購連結，請向團主重新索取<br>或直接前往官網訂購單選購";
      cta = officialBtn;
    }
    bar.className = "group-bar locked";
    bar.innerHTML = `<div class="gb-title">🛒 ${nameTitle}</div><div class="gb-locked">${msg}</div>${cta}`;
    if ($("#orderForm")) $("#orderForm").style.display = "none";
    // 收起會誤導的主視覺（「請填寫商品…」）與商品輪播
    document.querySelectorAll(".hero-desc, .notice-pill, #bannerCarousel").forEach((el) => (el.style.display = "none"));
  }
}

// 單一委派：展開分類 + 數量 +/-
$("#catalog").addEventListener("click", (e) => {
  const header = e.target.closest(".cat-header");
  if (header) {
    const sec = header.closest(".cat-section");
    sec.classList.toggle("open");
    sec.querySelector(".cat-body").classList.toggle("hidden");
    return;
  }
  if (e.target.closest(".btn-add-mix")) {
    const slots = document.getElementById("mixSlots");
    slots.insertAdjacentHTML("beforeend", mixSlot(slots.children.length + 1));
    renumberMix();
    return;
  }
  const rmMix = e.target.closest(".mix-remove");
  if (rmMix) {
    rmMix.closest(".mix-slot").remove();
    renumberMix();
    updateCatBadges();
    updateCartTotal();
    clearItemsInvalid();
    return;
  }
  const btn = e.target.closest(".step");
  if (!btn) return;
  const inp = btn.parentElement.querySelector(".qty-input");
  const panel = btn.closest(".mix-panel");
  let v = parseInt(inp.value, 10) || 0;
  if (btn.classList.contains("plus")) {
    if (panel) {
      if (mixTotal(panel) < 6) v++;
    } else v = Math.min(999, v + 1);
  } else v = Math.max(0, v - 1);
  inp.value = v;
  if (panel) updateMixCounter(panel);
  updateCatBadges();
  updateCartTotal();
  clearItemsInvalid();
});

const mixTotal = (panel) =>
  [...panel.querySelectorAll(".qty-input")].reduce((s, i) => s + (parseInt(i.value, 10) || 0), 0);

function updateMixCounter(panel) {
  let n = 0,
    pd = 0;
  panel.querySelectorAll(".qty-input").forEach((i) => {
    const q = parseInt(i.value, 10) || 0;
    n += q;
    pd += q * (Number(i.dataset.pd) || 0);
  });
  panel.querySelector(".mix-count").textContent = n;
  panel.classList.toggle("full", n === 6);
  panel.classList.remove("invalid");
  const t = panel.querySelector(".mix-total");
  if (t) t.innerHTML = n ? ` ｜ 合計優惠 ${money(pd)}` : "";
}

function eachBottleBox(cb) {
  document.querySelectorAll("#catalog .catalog-row").forEach((row) => {
    const inp = row.querySelector(".qty-input");
    if (!inp) return; // mix-head 無 stepper（這裡其實沒有 mix row）
    cb(row, parseInt(inp.value, 10) || 0);
  });
}

function updateCatBadges() {
  document.querySelectorAll(".cat-section").forEach((sec) => {
    let n = 0;
    sec.querySelectorAll(".catalog-row .qty-input").forEach((i) => {
      if ((parseInt(i.value, 10) || 0) > 0) n++;
    });
    sec.querySelectorAll(".mix-panel").forEach((p) => {
      if (mixTotal(p) > 0) n++;
    });
    const badge = sec.querySelector(".cat-badge");
    badge.textContent = n ? `已選 ${n}` : "";
  });
}

function updateCartTotal() {
  let amt = 0,
    lines = 0;
  eachBottleBox((row, q) => {
    if (q > 0) {
      lines++;
      amt += q * (Number(row.dataset.pd) || 0);
    }
  });
  document.querySelectorAll("#catalog .mix-panel").forEach((panel) => {
    let mq = 0,
      mamt = 0;
    panel.querySelectorAll(".qty-input").forEach((i) => {
      const q = parseInt(i.value, 10) || 0;
      mq += q;
      mamt += q * (Number(i.dataset.pd) || 0);
    });
    if (mq > 0) {
      lines++;
      amt += mamt;
    }
  });
  $("#cartTotal").innerHTML = lines ? `已選 ${lines} 項 ｜ 合計優惠 <b>${money(amt)}</b>` : "";
  updateGiftPromo(amt);
}

/* ---------- 驗證 ---------- */
function validPhone(raw) {
  const digits = raw.replace(/[\s\-()]/g, "").replace(/^\+886/, "0");
  return /^0\d{8,9}$/.test(digits);
}
function ageFromBirthday(s) {
  const b = new Date(s + "T00:00:00");
  const t = new Date();
  let a = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
  return a;
}
// 生日：文字框可打字（自動補斜線）＋ 📅 日曆鈕可選；兩者同步
function normalizeBirthday(s) {
  const m = String(s || "").match(/^(\d{4})\D?(\d{1,2})\D?(\d{1,2})$/);
  if (!m) return "";
  const y = +m[1], mo = +m[2], da = +m[3];
  const dt = new Date(y, mo - 1, da);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== da) return ""; // 不存在的日期
  if (dt > new Date()) return ""; // 未來日期
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(da)}`;
}
const $bd = $("#birthday"), $bdPick = $("#birthdayPick");
$bdPick.max = new Date().toISOString().slice(0, 10);
$bdPick.addEventListener("change", () => {
  if ($bdPick.value) { $bd.value = $bdPick.value.replace(/-/g, "/"); $bd.dispatchEvent(new Event("input", { bubbles: true })); }
});
// 手機（觸控）：點透明 date input 本身即開原生日曆；桌機（可 hover）：點一下用 showPicker 開
if (window.matchMedia && window.matchMedia("(hover: hover)").matches && $bdPick.showPicker) {
  $bdPick.addEventListener("click", () => { try { $bdPick.showPicker(); } catch (_) {} });
}
$bd.addEventListener("input", () => {
  const d = $bd.value.replace(/\D/g, "").slice(0, 8);
  let out = d.slice(0, 4);
  if (d.length > 4) out += "/" + d.slice(4, 6);
  if (d.length > 6) out += "/" + d.slice(6, 8);
  if (out !== $bd.value) $bd.value = out;
  const iso = normalizeBirthday(out);
  if (iso) $bdPick.value = iso;
});

function collectItems() {
  const items = [];
  eachBottleBox((row, qty) => {
    if (qty > 0)
      items.push({
        name: row.dataset.name,
        spec: row.dataset.spec || null,
        qty,
        ...(row.dataset.flavor ? { flavor: row.dataset.flavor } : {}),
      });
  });
  document.querySelectorAll("#catalog .mix-panel").forEach((panel) => {
    const contents = [...panel.querySelectorAll(".qty-input")]
      .map((i) => ({ name: i.dataset.name, qty: parseInt(i.value, 10) || 0 }))
      .filter((c) => c.qty > 0);
    const total = contents.reduce((s, c) => s + c.qty, 0);
    if (total > 0)
      items.push({ name: "250ml 自由混搭組", spec: null, qty: 1, contents, _mixTotal: total, _panel: panel });
  });
  return items;
}

function showSuccess(idText) {
  $("#successId").textContent = idText || "";
  $("#app").classList.add("hidden");
  $("#success").classList.remove("hidden");
  window.scrollTo(0, 0);
}

/* ---------- 送出 ---------- */
$("#orderForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearInvalid();

  const name = $("#name").value.trim();
  const phone = $("#phone").value.trim();
  const lineName = $("#line_name").value.trim();
  const birthday = $("#birthday").value.trim();
  const bdIso = normalizeBirthday(birthday);
  const items = collectItems();
  const ageConfirmed = $("#age").checked;

  // 生日驗證滿18：未滿直接擋下並提醒
  if (bdIso && ageFromBirthday(bdIso) < 18) {
    markField($("#birthday"));
    showError("您未滿 18 歲，依法請勿填寫本表單。");
    $("#birthday").focus({ preventScroll: true });
    $("#birthday").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const missing = [];
  let firstBad = null;
  const flag = (el, label) => {
    markField(el);
    missing.push(label);
    if (!firstBad) firstBad = el;
  };

  if (!name) flag($("#name"), "姓名");
  if (!phone) flag($("#phone"), "聯絡電話");
  else if (!validPhone(phone)) flag($("#phone"), "正確的聯絡電話（例：0912345678）");
  if (!lineName) flag($("#line_name"), "Line 名稱");
  if (!birthday) flag($("#birthday"), "生日");
  else if (!bdIso) flag($("#birthday"), "正確的生日（西元年/月/日，例：1990/03/15）");
  if (items.length === 0) flag($("#catalog"), "想要的商品（至少一項）");

  let mixNo = 0;
  for (const it of items) {
    if (it._mixTotal === undefined) continue;
    mixNo++;
    if (it._mixTotal !== 6) {
      it._panel.classList.add("invalid");
      $("#itemsField").classList.add("invalid");
      missing.push(`自由混搭第 ${mixNo} 組需湊滿6瓶（目前 ${it._mixTotal} 瓶）`);
      if (!firstBad) firstBad = it._panel;
    }
  }

  if (!ageConfirmed) flag($("#age"), "勾選「我已年滿 18 歲」");

  if (missing.length) {
    showError("尚有必填項目未完成，請填寫：" + missing.join("、"));
    if (firstBad) firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const attr = getAttribution();
  const payload = {
    name,
    phone,
    line_name: lineName,
    items: items.map(({ _mixTotal, _panel, ...rest }) => rest),
    note: $("#note").value.trim() || null,
    pickup: $("#pickup").value || null,
    birthday: bdIso || null,
    age_confirmed: ageConfirmed,
    host_slug: GROUP || null,
    company: $('input[name="company"]').value,
    // 廣告來源歸因（無則為 null，後端全欄 nullable）
    utm_source: attr.utm_source || null,
    utm_medium: attr.utm_medium || null,
    utm_campaign: attr.utm_campaign || null,
    utm_content: attr.utm_content || null,
    utm_term: attr.utm_term || null,
    fbclid: attr.fbclid || null,
    gclid: attr.gclid || null,
    landing_page: attr.landing_page || null,
  };

  const btn = $("#submitBtn");
  btn.disabled = true;
  btn.textContent = "傳送中…";

  if (DEV) {
    await new Promise((r) => setTimeout(r, 600));
    showSuccess("（本機測試模式｜未實際送出）");
    return;
  }

  try {
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "送出失敗");
    trackLead(data.id); // GA4 轉換事件（帶 UTM）
    showSuccess(data.id ? `訂購意向編號：#${data.id}` : "");
  } catch (e2) {
    showError(e2.message || "送出失敗，請稍後再試");
    btn.disabled = false;
    btn.textContent = "送出訂購意向";
  }
});

function showError(msg) {
  const el = $("#formError");
  el.textContent = msg;
  el.classList.toggle("show", !!msg);
}
function markField(el) {
  const box = el.closest(".field") || el.closest(".check");
  if (box) box.classList.add("invalid");
}
function clearInvalid() {
  document.querySelectorAll("#orderForm .invalid").forEach((b) => b.classList.remove("invalid"));
  showError("");
}
function clearItemsInvalid() {
  $("#itemsField").classList.remove("invalid");
  document.querySelectorAll("#catalog .mix-panel").forEach((p) => p.classList.remove("invalid"));
  if (!document.querySelector("#orderForm .invalid")) showError("");
}
$("#orderForm").addEventListener("input", onFieldFix);
$("#orderForm").addEventListener("change", onFieldFix);
function onFieldFix(e) {
  const box = e.target.closest(".field") || e.target.closest(".check");
  if (box) box.classList.remove("invalid");
  if (!document.querySelector("#orderForm .invalid")) showError("");
}

// 取貨方式：依選擇顯示對應說明（運費以文字呈現，不計入金額）
const PICKUP_HINTS = {
  "": `送出後，請務必<a href="https://lin.ee/9vx41HN" target="_blank" rel="noopener noreferrer">加入官方 LINE ＠plumate</a>。專人將透過官方 LINE 與您確認取貨與寄送方式。<br>・若需要專人送貨服務，收 <b>$130</b> 送貨服務費，需出示相關證明文件<br>・單筆滿 <b>$3,000</b> 可免收服務費<br><span class="pickup-sub">官方 LINE 客服時間 10:00–18:00</span>`,
  headquarters: `🏢 總公司：<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("台北市中山區松江路431巷25號1樓")}" target="_blank" rel="noopener noreferrer">台北市中山區松江路 431 巷 25 號 1 樓</a><br>☎ <a href="tel:0225077999">02-2507-7999</a>　（自取免運費）<br>🕙 營業時間：10:00–18:00（國定例假日休息）`,
  delivery: `・若需要專人送貨服務，收 <b>$130</b> 送貨服務費，需出示相關證明文件<br>・單筆滿 <b>$3,000</b> 可免收服務費`,
};
function renderPickupHint() {
  const el = $("#pickupHint");
  if (!el) return;
  el.innerHTML = PICKUP_HINTS[$("#pickup").value] || "";
}
$("#pickup").addEventListener("change", renderPickupHint);
renderPickupHint();

// 主 banner 輪播：自動播 + 圓點 + 手機滑動；只有 1 張時不啟用
function initBannerCarousel() {
  const root = document.getElementById("bannerCarousel");
  if (!root) return;
  const track = root.querySelector(".bc-track");
  const slides = [...root.querySelectorAll(".bc-slide")];
  const dotsWrap = root.querySelector(".bc-dots");
  if (slides.length <= 1) { if (dotsWrap) dotsWrap.remove(); return; }
  let i = 0, timer = null;
  slides.forEach((_, n) => {
    const d = document.createElement("button");
    d.type = "button"; d.className = "bc-dot" + (n === 0 ? " active" : "");
    d.setAttribute("aria-label", `第 ${n + 1} 張`);
    d.addEventListener("click", () => { go(n); restart(); });
    dotsWrap.appendChild(d);
  });
  const dots = [...dotsWrap.children];
  function go(n) {
    i = (n + slides.length) % slides.length;
    track.style.transform = `translateX(-${i * 100}%)`;
    dots.forEach((d, k) => d.classList.toggle("active", k === i));
  }
  const next = () => go(i + 1);
  const start = () => { timer = setInterval(next, 4500); };
  const stop = () => clearInterval(timer);
  const restart = () => { stop(); start(); };
  start();
  root.addEventListener("mouseenter", stop);
  root.addEventListener("mouseleave", start);
  let x0 = null;
  root.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; stop(); }, { passive: true });
  root.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 40) (dx < 0 ? next() : go(i - 1));
    x0 = null; start();
  }, { passive: true });
}
initBannerCarousel();

function showDevBanner() {
  if (document.getElementById("devBanner")) return;
  const b = document.createElement("div");
  b.id = "devBanner";
  b.className = "dev-banner";
  b.textContent = "本機測試模式：送出不會真的寄出（正式網域不顯示此列）";
  document.body.prepend(b);
}
