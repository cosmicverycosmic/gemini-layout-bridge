#!/usr/bin/env node

/**
 * Gemini Layout Worker
 *
 * - Detects React (TSX) vs Angular (HTML) Gemini apps
 * - Extracts sections (TSX components or <section> blocks)
 * - Classifies each section via TinyLlama (llm_classifier.py)
 * - Builds a layout JSON and POSTs it back to WordPress.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Node 18+ has global fetch; for safety, require('node-fetch') if needed.
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}

/* ========== CLI ARG PARSING ========== */

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    jobId: null,
    jobSecret: null,
    builder: 'divi',
    appDir: './app',
    callbackUrl: null,
    pageTitle: '',
    slug: ''
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--job-id') out.jobId = args[++i];
    else if (a === '--job-secret') out.jobSecret = args[++i];
    else if (a === '--builder') out.builder = args[++i];
    else if (a === '--app-dir') out.appDir = args[++i];
    else if (a === '--callback-url') out.callbackUrl = args[++i];
    else if (a === '--page-title') out.pageTitle = args[++i];
    else if (a === '--slug') out.slug = args[++i];
  }

  if (!out.jobId || !out.jobSecret || !out.appDir || !out.callbackUrl) {
    console.error('[GLB Worker] Missing one or more required arguments: --job-id, --job-secret, --app-dir, --callback-url');
    process.exit(1);
  }

  return out;
}

/* ========== UTILITIES ========== */

function readFileIfExists(p) {
  try {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8');
    }
  } catch (err) {
    console.warn('[GLB Worker] Failed to read file:', p, err.message);
  }
  return null;
}

function listFilesRecursive(dir, filterFn) {
  const out = [];
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (!filterFn || filterFn(full)) {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTsxToText(src) {
  if (!src) return '';
  let s = src;

  // Remove imports/exports
  s = s.replace(/^\s*import[\s\S]*?;$/gm, '');
  s = s.replace(/^\s*export[\s\S]*?$/gm, '');

  // Remove comments
  s = s.replace(/\/\/[^\n]*\n/g, '\n');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');

  // Remove JS/TS blocks in {}
  s = s.replace(/\{[^{}]*\}/g, ' ');

  // Remove JSX tags
  s = s.replace(/<[^>]+>/g, ' ');

  // Normalize whitespace
  s = s.replace(/\s+/g, ' ');

  return s.trim();
}

/* ========== LLM CLASSIFIER BRIDGE ========== */

function guessDiviMetaFromHeuristics(text, idOrName) {
  const t = (text || '').toLowerCase();
  const id = (idOrName || '').toLowerCase();

  function contains(...words) {
    return words.some(w => t.includes(w) || id.includes(w));
  }

  // Very rough heuristics
  if (contains('hero', 'welcome', 'above the fold', 'landing', 'headline')) {
    return {
      module_type: 'fullwidth_header',
      params: {}
    };
  }

  if (contains('price', 'pricing', 'plan', 'tier')) {
    return {
      module_type: 'pricing_tables',
      params: {}
    };
  }

  if (contains('faq', 'question', 'answer')) {
    return {
      module_type: 'faq_accordion',
      params: {}
    };
  }

  if (contains('testimonial', 'what our clients say', 'review')) {
    return {
      module_type: 'testimonials_slider',
      params: {}
    };
  }

  if (contains('contact', 'get in touch', 'reach us', 'email', 'phone')) {
    return {
      module_type: 'contact_form',
      params: {}
    };
  }

  if (contains('service', 'features', 'what we do', 'solutions')) {
    return {
      module_type: 'blurb_grid',
      params: {}
    };
  }

  return {
    module_type: 'code',
    params: {}
  };
}

function classifyWithLLM(snippet, idOrName) {
  const text = (snippet || '').trim();
  const heuristics = guessDiviMetaFromHeuristics(text, idOrName);

  // Allow disabling LLM for debugging
  if (!text || process.env.GLB_LLM_ENABLED === '0') {
    return {
      type: 'generic',
      builder: {
        divi: heuristics
      }
    };
  }

  const maxInput = 1800;
  const clipped = text.length > maxInput ? text.slice(0, maxInput) : text;

  const payload = JSON.stringify({
    snippet: clipped,
    heuristics
  });

  try {
    const res = spawnSync('python', ['scripts/llm_classifier.py'], {
      input: payload,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });

    if (res.error) {
      console.warn('[LLM] spawn error:', res.error.message);
      return {
        type: 'generic',
        builder: { divi: heuristics }
      };
    }

    const stdout = (res.stdout || '').trim();
    if (!stdout) {
      console.warn('[LLM] empty stdout, using heuristics only');
      return {
        type: 'generic',
        builder: { divi: heuristics }
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      console.warn('[LLM] JSON parse error, stdout was:', stdout);
      return {
        type: 'generic',
        builder: { divi: heuristics }
      };
    }

    const type = parsed.type || 'generic';
    let builder = parsed.builder || {};
    if (!builder.divi) {
      builder.divi = heuristics;
    }

    return { type, builder };
  } catch (err) {
    console.warn('[LLM] classifier failed:', err.message);
    return {
      type: 'generic',
      builder: { divi: heuristics }
    };
  }
}

/* ========== HEAD / BODY EXTRACTION ========== */

function extractHeadAndBody(appDir) {
  const indexPath = path.join(appDir, 'index.html');
  const raw = readFileIfExists(indexPath);
  if (!raw) {
    return { headHtml: '', bodyClass: '' };
  }

  let headHtml = '';
  let bodyClass = '';
  try {
    const headMatch = raw.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (headMatch) {
      const headInner = headMatch[1];
      // Keep Tailwind + fonts, drop bundler scripts
      const filtered = headInner
        .split('\n')
        .filter(line => {
          if (line.includes('type="module"')) return false;
          if (line.includes('main.js')) return false;
          if (line.includes('index.tsx')) return false;
          return true;
        })
        .join('\n');
      headHtml = filtered.trim();
    }

    const bodyTagMatch = raw.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
    if (bodyTagMatch) {
      const bodyAttrs = bodyTagMatch[1] || '';
      const classMatch = bodyAttrs.match(/class="([^"]*)"/i);
      if (classMatch) {
        bodyClass = classMatch[1];
      }
    }
  } catch (err) {
    console.warn('[GLB Worker] Failed to parse head/body:', err.message);
  }

  return { headHtml, bodyClass };
}

function getRootHtmlFromIndex(appDir) {
  const indexPath = path.join(appDir, 'index.html');
  const raw = readFileIfExists(indexPath);
  if (!raw) return '<div id="root"></div>';

  const bodyMatch = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return '<div id="root"></div>';

  let bodyInner = bodyMatch[1] || '';
  // Drop scripts
  bodyInner = bodyInner.replace(/<script[\s\S]*?<\/script>/gi, '');
  return bodyInner.trim() || '<div id="root"></div>';
}

/* ========== ANGULAR HELPERS ========== */

function splitAngularTemplateIntoSections(templateHtml) {
  if (!templateHtml) return [];

  const sections = [];
  const regex = /<section\b[^>]*>[\s\S]*?<\/section>/gi;
  let match;
  while ((match = regex.exec(templateHtml)) !== null) {
    sections.push(match[0]);
  }

  if (!sections.length) {
    // No explicit <section>; treat full template as one.
    sections.push(templateHtml);
  }
  return sections;
}

/* ========== MAIN ANALYSIS ========== */

async function analyzeAppToSections(appDir, builder) {
  console.log('[GLB Worker] Analyzing app at', appDir);

  const angularJsonPath = path.join(appDir, 'angular.json');
  const angularComponentPath = path.join(appDir, 'src', 'app.component.html');
  const isAngularApp =
    fs.existsSync(angularJsonPath) || fs.existsSync(angularComponentPath);

  let angularTemplateHtml = null;
  if (isAngularApp && fs.existsSync(angularComponentPath)) {
    angularTemplateHtml = readFileIfExists(angularComponentPath);
    console.log('[GLB Worker] Detected Angular app; app.component.html found.');
  }

  // Gather TSX files for React-style apps
  const tsxFiles = listFilesRecursive(appDir, f => f.endsWith('.tsx'));

  // Filter out index.tsx (bootstrapping only)
  const sectionTsxFiles = tsxFiles.filter(f => path.basename(f).toLowerCase() !== 'index.tsx');

  const sections = [];

  // React-style components
  if (sectionTsxFiles.length) {
    console.log('[GLB Worker] Found TSX section files:', sectionTsxFiles);
    for (const file of sectionTsxFiles) {
      const src = readFileIfExists(file);
      if (!src) continue;

      const shortName = path.basename(file, path.extname(file));
      const snippet = stripTsxToText(src);
      const classification = classifyWithLLM(snippet, shortName);

      const type = classification.type || 'generic';
      const builderMap = classification.builder || {};

      // For safety, keep divi mapping under builder.divi
      const diviMeta = builderMap.divi || guessDiviMetaFromHeuristics(snippet, shortName);

      // For now, html = placeholder root div; in a more advanced version,
      // you would run SSR with Vite/React. Here we expect Classic/Divi
      // to primarily rely on builder metadata to construct modules.
      sections.push({
        id: shortName,
        class: '',
        html: `<div id="${shortName.toLowerCase()}-root"></div>`,
        type,
        builder: {
          divi: diviMeta
        }
      });
    }
  }

  // If no TSX sections, but Angular template exists → use Angular HTML as real content.
  if (!sectionTsxFiles.length && isAngularApp && angularTemplateHtml) {
    console.log('[GLB Worker] No TSX sections; using Angular app.component.html content.');

    const angularSections = splitAngularTemplateIntoSections(angularTemplateHtml);
    let index = 0;
    for (const html of angularSections) {
      index++;

      const idMatch = html.match(/id="([^"]+)"/i);
      const id = idMatch ? idMatch[1] : `section-${index}`;

      const textSnippet = stripHtml(html);
      const classification = classifyWithLLM(textSnippet, id);

      const type = classification.type || 'generic';
      const builderMap = classification.builder || {};
      const diviMeta = builderMap.divi || guessDiviMetaFromHeuristics(textSnippet, id);

      sections.push({
        id,
        class: '',
        html,
        type,
        builder: {
          divi: diviMeta
        }
      });
    }
  }

  // Fallback: if we still have nothing, use index.html body as one "root" section.
  if (!sections.length) {
    console.log('[GLB Worker] No sections discovered; falling back to index.html body.');
    const rootHtml = getRootHtmlFromIndex(appDir);
    sections.push({
      id: 'root',
      class: 'glb-section glb-section-root glb-type-generic',
      html: rootHtml,
      type: 'generic',
      builder: {
        divi: { module_type: 'code', params: {} }
      }
    });
  }

  return sections;
}

/* ========== CALLBACK TO WORDPRESS ========== */

async function postLayoutToWordPress(callbackUrl, jobId, jobSecret, layout) {
  console.log('[GLB Worker] Posting layout back to WordPress callback …');

  const payload = {
    job_id: jobId,
    secret: jobSecret,
    layout
  };

  const res = await fetchFn(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const status = res.status;
  let text = '';
  try {
    text = await res.text();
  } catch (err) {
    text = '';
  }

  console.log('[GLB Worker] WP callback status:', status);
  if (text) {
    console.log('[GLB Worker] WP callback response body:', text);
  }

  if (status < 200 || status >= 300) {
    throw new Error('WordPress callback returned HTTP ' + status);
  }
}

/* ========== MAIN ========== */

(async () => {
  const args = parseArgs();
  console.log(
    `[GLB Worker] Starting job ${args.jobId}, builder=${args.builder}, appDir=${args.appDir}`
  );

  const { headHtml, bodyClass } = extractHeadAndBody(args.appDir);
  const sections = await analyzeAppToSections(args.appDir, args.builder);

  const layout = {
    head_html: headHtml,
    body_class: bodyClass,
    sections
  };

  try {
    await postLayoutToWordPress(args.callbackUrl, args.jobId, args.jobSecret, layout);
    console.log('[GLB Worker] Done.');
  } catch (err) {
    console.error('[GLB Worker] Error posting layout to WordPress:', err.message);
    process.exit(1);
  }
})();
