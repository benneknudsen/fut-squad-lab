/* Functional smoke test for reference/vision.html.
   Runs the real page script against jsdom and asserts the panel's structure,
   every state, both languages, and the core interactions. Run:
     cd /tmp/fsl-test && node <project>/tools/vision-smoke-test.js <project>/reference/vision.html
   (needs jsdom; the module is resolved from the working directory.) */
const fs = require("fs");
const { JSDOM } = require("jsdom");

const file = process.argv[2];
const html = fs.readFileSync(file, "utf8");
const errors = [];

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
const { window } = dom;
window.addEventListener("error", (e) => errors.push("window error: " + e.message));
const origError = window.console.error;
window.console.error = (...a) => { errors.push("console.error: " + a.join(" ")); origError(...a); };

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => Array.from(window.document.querySelectorAll(s));
const txt = (s) => ($(s) ? $(s).textContent.trim() : "<missing>");
const click = (n) => n.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const ok = [], bad = [];
function check(name, cond, detail) { (cond ? ok : bad).push(name + (cond ? "" : "  → " + detail)); }

/* ── defaults: the solved view with purchases ───────────────────────────── */
check("11 slot rows render", $$(".fsl-row").length === 11, "got " + $$(".fsl-row").length);
check("each row has a lock toggle", $$(".fsl-lock").length === 11, "got " + $$(".fsl-lock").length);
check("4 card states are present",
  ["tradeable", "untradeable", "duplicate", "concept"].every((s) => $$(".fsl-chip[data-state='" + s + "']").length >= 1),
  ["tradeable", "untradeable", "duplicate", "concept"].map((s) => s + ":" + $$(".fsl-chip[data-state='" + s + "']").length).join(" "));
check("locked rows are marked", $$(".fsl-row[data-locked='true']").length === 2, "got " + $$(".fsl-row[data-locked='true']").length);
check("every chip carries a glyph and a word (never colour alone)",
  $$(".fsl-chip").every((c) => c.querySelector("svg") && c.textContent.trim().length > 2),
  $$(".fsl-chip").filter((c) => !c.querySelector("svg") || c.textContent.trim().length <= 2).length + " chip(s) fail");
check("every chip carries a state description", $$(".fsl-chip").every((c) => c.getAttribute("title")), "missing title");
check("alternatives render inline inside the panel, not as a floating card",
  $$(".fsl-panel .fsl-alts").length === 1 && $$(".fsl-alts").length === 1, "got " + $$(".fsl-alts").length);
check("alternatives rank players with a reason each",
  $$(".fsl-alts .fsl-alt").length >= 4 && $$(".fsl-alts .fsl-alt-reason").length >= 4,
  "alts " + $$(".fsl-alts .fsl-alt").length + ", reasons " + $$(".fsl-alts .fsl-alt-reason").length);
check("the in-squad player is marked current", $$(".fsl-alt[data-current='true']").length === 1, "got " + $$(".fsl-alt[data-current='true']").length);
check("buy section lists exactly the concept cards", $$(".fsl-buy-row").length === 3, "got " + $$(".fsl-buy-row").length);
check("buy section is separated from the club cards", !!$(".fsl-list + .fsl-buy"), "not adjacent to the list");
check("cost summary has all five cells", $$(".fsl-costbar .fsl-cell").length === 5, "got " + $$(".fsl-costbar .fsl-cell").length);
check("total fodder cost is rendered", /16[.,]140/.test(txt("#costTotal")), "got " + txt("#costTotal"));
check("cost summary is one live region", $(".fsl-costbar").getAttribute("aria-live") === "polite", "no aria-live");
check("one primary action per surface", $$(".fsl-panel .fsl-btn-primary").length === 1, "got " + $$(".fsl-panel .fsl-btn-primary").length);
check("slot rows are reachable as buttons", $$(".fsl-row-toggle").length === 11, "got " + $$(".fsl-row-toggle").length);
check("open row reports aria-expanded", $$(".fsl-row-toggle")[5].getAttribute("aria-expanded") === "true", "slot 06 not expanded");
check("open row points at its alternatives", $$(".fsl-row-toggle")[5].getAttribute("aria-controls") === "alts-5", "no aria-controls");
check("every row has an accessible name", $$(".fsl-row-toggle").every((b) => b.textContent.trim().length > 4), "a row has no text");

/* ── interactions ───────────────────────────────────────────────────────── */
const swapBtn = $$(".fsl-alt[data-act='swap']")[0];
const beforeTotal = txt("#costTotal");
const beforeName = $$(".fsl-row")[5].querySelector(".fsl-ident-name").textContent;
click(swapBtn);
check("swap changes the player", $$(".fsl-row")[5].querySelector(".fsl-ident-name").textContent !== beforeName, "still " + beforeName);
check("swap re-settles the cost", txt("#costTotal") !== beforeTotal, beforeTotal + " → " + txt("#costTotal"));
check("swap closes the alternatives", $$(".fsl-alts").length === 0, "still open");
check("swapped row shows the confirmation state", $$(".fsl-row[data-swapped='true']").length === 1, "got " + $$(".fsl-row[data-swapped='true']").length);
check("swapped row keeps a written card state", $$(".fsl-row")[5].querySelector(".fsl-chip").getAttribute("data-state") === "tradeable",
  $$(".fsl-row")[5].querySelector(".fsl-chip").getAttribute("data-state"));

const lockBefore = $$(".fsl-row[data-locked='true']").length;
click($$(".fsl-lock")[0]);
check("lock toggles a slot", $$(".fsl-row[data-locked='true']").length === lockBefore + 1,
  lockBefore + " → " + $$(".fsl-row[data-locked='true']").length);
check("locked slot still shows its card state", !!$$(".fsl-row")[0].querySelector(".fsl-chip").getAttribute("data-state"), "state lost");
const unlocked = $$(".fsl-lock").filter((b) => b.getAttribute("aria-pressed") === "false");
check("a locked slot reports aria-pressed", $$(".fsl-lock")[0].getAttribute("aria-pressed") === "true", "not pressed");
check("unlocked slots stay toggleable", unlocked.length === 11 - $$(".fsl-row[data-locked='true']").length, "got " + unlocked.length);

/* ── every view renders ─────────────────────────────────────────────────── */
["idle", "solving", "solved", "buy", "noSolution", "notOnPage"].forEach((v) => {
  const btn = $$("#stateSeg button").find((b) => b.getAttribute("data-state") === v);
  if (!btn) { bad.push("state button " + v + " missing"); return; }
  click(btn);
  const body = $(".fsl-panel").textContent;
  check("view '" + v + "' renders content", body.length > 60, "panel text too short");
  check("view '" + v + "' has no unresolved values", !/undefined|\[object|\{value\}|\{cards\}|NaN/.test(body),
    (body.match(/undefined|\[object|\{value\}|\{cards\}|NaN/) || [])[0]);
  if (v === "noSolution") {
    check("no-solution view states the exact deficits", $$(".fsl-missing li").length === 4 && /−3|−2|−12/.test($(".fsl-missing").textContent),
      $$(".fsl-missing li").length + " items");
    check("no-solution view is not an error box", $(".fsl-view").getAttribute("data-tone") === "warning" && !/danger/.test($(".fsl-view").className), "tone missing");
    check("no-solution view offers three ways forward", $$(".fsl-fix").length === 3, "got " + $$(".fsl-fix").length);
    check("no-solution view has no primary button", $$(".fsl-panel .fsl-btn-primary").length === 0, "has one");
  }
  if (v === "solving") {
    check("solving shows a five-step search, not a spinner", $$(".fsl-step").length === 5 && $$(".fsl-skeleton").length === 11,
      $$(".fsl-step").length + " steps");
    check("solving disables the primary action", !!$(".fsl-panel .fsl-btn-primary[disabled]"), "not disabled");
  }
  if (v === "idle") check("idle has exactly one primary action", $$(".fsl-panel .fsl-btn-primary").length === 1, "got " + $$(".fsl-panel .fsl-btn-primary").length);
});
click($$("#stateSeg button").find((b) => b.getAttribute("data-state") === "buy"));

/* ── width ──────────────────────────────────────────────────────────────── */
click($$("#widthSeg button").find((b) => b.getAttribute("data-width") === "320"));
check("panel width switches to 320 px", /--rb-panel-w:\s*320px/.test($(".fsl-panel").getAttribute("style")), $(".fsl-panel").getAttribute("style") || "no style");
check("all 11 rows survive at 320 px", $$(".fsl-row").length === 11, "got " + $$(".fsl-row").length);
click($$(".fsl-row-toggle")[0]);
check("alternatives survive at 320 px", $$(".fsl-alts .fsl-alt").length >= 3, "got " + $$(".fsl-alts .fsl-alt").length);
check("narrow containers reflow via container queries", html.indexOf("@container (max-width: 348px)") > -1, "no container query");

/* width budget: jsdom cannot measure, so model the column arithmetic with the
   token advances (mono 10px ≈ 6.2 px/char, UI 13px ≈ 7.0 px/char) and assert
   that neither line of any slot row can overflow its column. */
function budget(panelPx) {
  const compact = panelPx <= 348;                       // container query breakpoint
  const pad = compact ? 8 : 12, gaps = compact ? 5 : 6;
  const fixed = (compact ? [38, 42, 32] : [44, 48, 32]).reduce((a, b) => a + b, 0) + 3 * gaps;
  const ident = panelPx - 2 - pad * 2 - fixed;
  return $$(".fsl-row").map((row) => {
    const name = row.querySelector(".fsl-ident-name").textContent.trim();
    const meta = row.querySelector(".fsl-meta").textContent.replace(/\s+/g, "");
    const word = row.querySelector(".fsl-chip > span") ? row.querySelector(".fsl-chip > span").textContent.trim() : "";
    const chip = compact ? 22 : 12 + 11 + 4 + word.length * 6.2;
    const line1 = name.length * 7.0 + chip + 16;
    const line2 = meta.length * 6.2 + 16;
    return { ident, line1, line2, ok: line1 <= ident && line2 <= ident, name, word, meta };
  });
}
[[400, "400 px"], [320, "320 px"]].forEach(([w, label]) => {
  const rows = budget(w);
  const worst = rows.reduce((a, b) => (Math.max(b.line1, b.line2) / b.ident > Math.max(a.line1, a.line2) / a.ident ? b : a), rows[0]);
  check("no slot row can overflow its column at " + label,
    rows.every((r) => r.ok), rows.filter((r) => !r.ok).map((r) => r.name + " line1 " + Math.round(r.line1) + "/" + r.ident + " line2 " + Math.round(r.line2)).join("; "));
  check("rows fit with headroom at " + label,
    Math.max(worst.line1, worst.line2) <= worst.ident * 0.92,
    "tightest row uses " + Math.round((Math.max(worst.line1, worst.line2) / worst.ident) * 100) + "% of the column");
});

/* ── language ───────────────────────────────────────────────────────────── */
const daTotal = txt("#costTotal");
click($$("[data-lang='en']").find((b) => b.closest(".rb-lang")));
const enTotal = txt("#costTotal");
check("switching language re-renders the panel", $(".fsl-toolbar-count").textContent !== "",
  "empty");
check("danish groups with a dot, english with a comma", /\./.test(daTotal) && /,/.test(enTotal), daTotal + " vs " + enTotal);
check("english card-state labels are translated",
  $$(".fsl-chip").every((c) => /Tradeable|Untradeable|Duplicate|Concept|Locked/.test(c.textContent)),
  $$(".fsl-chip").map((c) => c.textContent.trim()).join(" | "));
check("no danish left in the english panel", !/Kan ikke|Skift|Dublet|Låst|Køb disse|Fyldpris/.test($(".fsl-panel").textContent),
  ($(".fsl-panel").textContent.match(/Kan ikke|Skift|Dublet|Låst|Køb disse|Fyldpris/) || [])[0]);
check("english options page is translated", /Settings|Fodder cost model|Gentle mode/.test($(".fsl-options").textContent), "options not translated");

/* ── copy coverage: every key the script asks for exists in both languages ─ */
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];
const keys = [...new Set([...src.matchAll(/\bt\("([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]))]
  .filter((k) => !k.endsWith("."));   // keys built by concatenation are covered by their prefixes
const missing = [];
keys.forEach((k) => {
  ["da", "en"].forEach((l) => {
    let n = window.COPY[l];
    for (const p of k.split(".")) { n = n && n[p]; }
    if (typeof n !== "string") { missing.push(l + ":" + k); }
  });
});
check("all " + keys.length + " copy keys resolve in both languages", missing.length === 0, missing.join(", "));

/* ── static page checks ─────────────────────────────────────────────────── */
check("every section carries data-od-id", $$("section.rb-section").every((s) => s.hasAttribute("data-od-id")),
  $$("section.rb-section").filter((s) => !s.hasAttribute("data-od-id")).length + " without");
check("no remote asset or font dependency", !/https?:\/\//.test(html), "found a remote url");
check("no placeholder scaffolding left", !/ph-img|\[REPLACE\]|\{\{/.test(html), "placeholder found");
check("no emoji used as icons", !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), "emoji found");
check("no scrollIntoView", !/scrollIntoView/.test(html), "found");
check("danish copy keeps its diacritics", /Løs igen|låst|Køb disse|Skånsom/.test(html), "transliterated danish");
check("no EA-owned mark, crest or likeness is referenced",
  !/EA SPORTS FC|eafc|fifa\s*\d|crest[^ ]*\.(png|svg|jpg)|club[-_]?badge\.(png|svg|jpg)|portrait\.(png|jpg)/i.test(html),
  (html.match(/EA SPORTS FC|eafc|fifa\s*\d|crest[^ ]*\.(png|svg|jpg)|club[-_]?badge\.(png|svg|jpg)/i) || [])[0]);

/* the reference page inlines the copy contract — it must not drift from it */
const inlineCopy = new Function("return " + src.match(/var COPY = ([\s\S]*?);\n\n\/\* ── fixture/)[1] + ";")();
["da", "en"].forEach((l) => {
  const json = JSON.parse(fs.readFileSync(require("path").join(require("path").dirname(file), "..", "copy." + l + ".json"), "utf8"));
  const flat = (o, p = "") => Object.entries(o).reduce((acc, [k, v]) => Object.assign(acc,
    typeof v === "object" && v ? flat(v, p + k + ".") : { [p + k]: v }), {});
  const a = flat(json), b = flat(inlineCopy[l]);
  const invented = Object.keys(b).filter((k) => !(k in a));
  const differing = Object.keys(b).filter((k) => k in a && a[k] !== b[k]);
  check("inline " + l.toUpperCase() + " copy is a faithful subset of copy." + l + ".json (" + Object.keys(b).length + " of " + Object.keys(a).length + " keys)",
    invented.length === 0 && differing.length === 0,
    "invented: " + invented.join(", ") + " | differing: " + differing.join(", "));
});
check("numeric readouts declare tabular figures", /font-variant-numeric: tabular-nums/.test(html), "missing");
check("reduced motion is honoured", /prefers-reduced-motion/.test(html), "missing");

console.log("\nPASS (" + ok.length + ")");
ok.forEach((o) => console.log("  ✓ " + o));
if (bad.length) { console.log("\nFAIL (" + bad.length + ")"); bad.forEach((b) => console.log("  ✗ " + b)); }
if (errors.length) { console.log("\nRUNTIME ERRORS (" + errors.length + ")"); errors.forEach((e) => console.log("  ! " + e)); }
console.log("\n" + (bad.length || errors.length ? "RESULT: FAIL" : "RESULT: PASS"));
process.exit(bad.length || errors.length ? 1 : 0);
