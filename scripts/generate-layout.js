#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawnSync } = require("child_process");
const https = require("https");
const http = require("http");

/**
 * Very small CLI arg parser (no external dep).
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv);

const JOB_ID = args["job-id"] || process.env.JOB_ID || "";
const JOB_SECRET = args["job-secret"] || process.env.JOB_SECRET || "";
const BUILDER = (args["builder"] || process.env.BUILDER || "divi").toLowerCase();
const APP_DIR = args["app-dir"] || "./app";
const CALLBACK_URL = args["callback-url"] || process.env.CALLBACK_URL || "";
const PAGE_TITLE = args["page-title"] || process.env.PAGE_TITLE || "";
const SLUG = args["slug"] || process.env.SLUG || "";

/* ---------- Utility helpers ---------- */

function slugify(str) {
  return (str || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function guessTypeFromName(name) {
  const lower = name.toLowerCase();
  if (lower.includes("hero")) return "hero";
  if (lower.includes("service")) return "services";
  if (lower.includes("pricing") || lower.includes("plan")) return "pricing";
  if (lower.includes("faq")) return "faq";
  if (lower.includes("testimonials") || lower.includes("testimonial")) return "testimonials";
  if (lower.includes("contact")) return "contact";
  if (lower.includes("about")) return "about";
  if (lower.includes("process")) return "process";
  if (lower.includes("region") || lower.includes("map")) return "region";
  return "generic";
}

function extractReturnJsx(src) {
  // Very crude: look for "return (" and matching ");"
  const idx = src.indexOf("return (");
  if (idx === -1) return "";
  const after = src.slice(idx + "return (".length);
  let depth = 1;
  let end = -1;
  for (let i = 0; i < after.length; i++) {
    const ch = after[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return after;
  return after.slice(0, end);
}

function tsxToStaticHtml(jsx) {
  if (!jsx) return "";

  let html = jsx;

  // Remove React fragments
  html = html.replace(/<React\.Fragment>/g, "").replace(/<\/React\.Fragment>/g, "");
  html = html.replace(/<>/g, "").replace(/<\/>/g, "");

  // Strip TS/JS comments
  html = html.replace(/\/\*[\s\S]*?\*\//g, "");
  html = html.replace(/\/\/[^\n]*/g, "");

  // Replace className -> class
  html = html.replace(/\bclassName=/g, "class=");

  // Replace HTML-like self-closing React components (icons etc) with spans.
  html = html.replace(
    /<([A-Z][A-Za-z0-9_]*)((\s+[^>]*?)?)\/>/g,
    (m, compName) =>
      `<span class="glb-component-placeholder" data-component="${compName}"></span>`
  );

  // Remove JSX expression braces around simple strings: {"Text"} -> Text
  html = html.replace(/\{\s*"([^"]*)"\s*\}/g, "$1");

  // Kill obvious TSX type annotations inside tags, e.g. <div key={idx as number}>
  html = html.replace(/\sas\s+[A-Za-z0-9_\[\]\|]+/g, "");

  // JSX attributes like onClick, etc. – keep them as-is for now (mostly ignored by browser).
  // You could strip them if you want purely static HTML.

  return html.trim();
}

function extractTextHint(src) {
  // Grab some lines with quoted strings – good enough for a hint.
  const lines = src.split("\n");
  const interesting = [];
  for (const line of lines) {
    if (/"[^"]+"/.test(line)) {
      interesting.push(line.trim());
    }
    if (interesting.length >= 12) break;
  }
  return interesting.join(" ");
}

/**
 * Extract <head> (scripts, styles) and body classes from index.html if present.
 */
async function extractHeadAndBody(appDir) {
  const indexPath = path.join(appDir, "index.html");
  let headHtml = "";
  let bodyClass = "";

  try {
    const html = await fsp.readFile(indexPath, "utf8");
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (headMatch) {
      // Strip outer <head> wrapper, keep inner contents.
      headHtml = headMatch[1].trim();
    }
    const bodyMatch = html.match(/<body([^>]*)>/i);
    if (bodyMatch) {
      const attr = bodyMatch[1] || "";
      const classMatch = attr.match(/class\s*=\s*"([^"]*)"/i);
      if (classMatch) {
        bodyClass = classMatch[1].trim();
      }
    }
  } catch (e) {
    // no index.html – fine.
  }

  return { headHtml, bodyClass };
}

/**
 * Collect TSX sections from /components and root App.tsx as a fallback.
 */
async function collectSections(appDir) {
  const componentsDir = path.join(appDir, "components");
  const sections = [];

  async function addTsxFile(filePath) {
    const src = await fsp.readFile(filePath, "utf8");
    const name = path.basename(filePath, ".tsx");
    const jsx = extractReturnJsx(src);
    const htmlInner = tsxToStaticHtml(jsx);
    if (!htmlInner) return;

    const id = slugify(name);
    const type = guessTypeFromName(name);
    const textHint = extractTextHint(src);

    // Wrap in a <section> for classic output & consistency.
    const html = `<section id="${id}" class="glb-section glb-section-${id} glb-type-${type}">\n${htmlInner}\n</section>`;

    sections.push({
      id,
      name,
      type,
      html,
      text: textHint,
    });
  }

  if (fs.existsSync(componentsDir) && fs.statSync(componentsDir).isDirectory()) {
    const files = await fsp.readdir(componentsDir);
    for (const file of files) {
      if (file.toLowerCase().endsWith(".tsx")) {
        await addTsxFile(path.join(componentsDir, file));
      }
    }
  }

  // Fallback: if no explicit components found, treat App.tsx as one big section.
  if (sections.length === 0) {
    const appTsx = path.join(appDir, "App.tsx");
    if (fs.existsSync(appTsx)) {
      await addTsxFile(appTsx);
    }
  }

  return sections;
}

/**
 * Call the on-repo LLM classifier (llm_classifier.py) to get Divi mappings.
 */
function classifyWithLLM(sections) {
  const payload = {
    sections: sections.map((s) => ({
      id: s.id,
      type: s.type,
      text: s.text,
      html: s.html,
    })),
  };

  const proc = spawnSync("python", ["scripts/llm_classifier.py"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

  if (proc.status !== 0) {
    console.error("[LLM] classifier failed:", proc.stderr || proc.stdout);
    throw new Error("LLM classifier failed");
  }

  let data;
  try {
    data = JSON.parse(proc.stdout);
  } catch (e) {
    console.error("[LLM] JSON parse error:", e, proc.stdout);
    throw e;
  }

  if (!data.sections || !Array.isArray(data.sections)) {
    throw new Error("LLM result missing sections");
  }

  // Merge back into our sections by id.
  const byId = {};
  for (const s of data.sections) {
    if (!s || !s.id) continue;
    byId[s.id] = s;
  }

  for (const s of sections) {
    const mapped = byId[s.id];
    if (mapped && mapped.divi) {
      s.divi_meta = mapped.divi;
    } else {
      // If LLM didn't map it, fallback to code module.
      s.divi_meta = {
        module_type: "code",
        params: {
          html_summary: `Auto-fallback code module for section ${s.id}`,
        },
      };
    }
  }

  return sections;
}

/**
 * POST layout JSON back to WP callback.
 */
function postToCallback(url, payload) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error("No callback URL provided"));

    const data = JSON.stringify(payload);
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const options = {
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = lib.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body });
        } else {
          reject(
            new Error(`Callback returned ${res.statusCode}: ${body || "no body"}`)
          );
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.write(data);
    req.end();
  });
}

/* ---------- Main flow ---------- */

(async () => {
  try {
    if (!JOB_ID || !JOB_SECRET) {
      throw new Error("JOB_ID and JOB_SECRET are required.");
    }

    console.log(`[GLB Worker] Starting job ${JOB_ID}, builder=${BUILDER}`);

    const { headHtml, bodyClass } = await extractHeadAndBody(APP_DIR);
    const sections = await collectSections(APP_DIR);

    if (!sections.length) {
      throw new Error("No TSX sections found to process.");
    }

    // Use LLM to attach Divi module metadata.
    classifyWithLLM(sections);

    // Classic HTML – one coherent page: just join our section HTML.
    const classicHtml = sections.map((s) => s.html).join("\n\n");

    const layout = {
      head_html: headHtml || "",
      body_class: bodyClass || "",
      sections: sections.map((s) => ({
        id: s.id,
        class: `glb-section glb-section-${s.id} glb-type-${s.type}`,
        html: s.html,
        type: s.type,
        builder: {
          divi: s.divi_meta || null,
        },
      })),
      // Extra convenience for future plugin updates; plugin can ignore this for now.
      classic_html: classicHtml,
    };

    const payload = {
      job_id: JOB_ID,
      secret: JOB_SECRET,
      layout,
      error: null,
    };

    console.log("[GLB Worker] Posting layout back to WordPress callback …");
    await postToCallback(CALLBACK_URL, payload);
    console.log("[GLB Worker] Done.");
  } catch (err) {
    console.error("[GLB Worker] Error:", err);
    if (CALLBACK_URL && JOB_ID && JOB_SECRET) {
      try {
        await postToCallback(CALLBACK_URL, {
          job_id: JOB_ID,
          secret: JOB_SECRET,
          layout: null,
          error: String(err && err.message ? err.message : err),
        });
      } catch (e2) {
        console.error("[GLB Worker] Failed to report error to callback:", e2);
      }
    }
    process.exit(1);
  }
})();
