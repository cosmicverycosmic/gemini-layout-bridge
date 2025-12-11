#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const axios = require('axios');
const { JSDOM } = require('jsdom');

let gCallbackUrl = '';
let gJobId = '';
let gJobSecret = '';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[i + 1];
      args[key] = value;
      i++;
    }
  }
  return args;
}

function runCommand(cwd, command) {
  console.log(`Running: ${command} (cwd=${cwd})`);
  execSync(command, { cwd, stdio: 'inherit' });
}

function findProjectDir(appDir) {
  const pkg = path.join(appDir, 'package.json');
  if (fs.existsSync(pkg)) {
    return appDir;
  }
  const entries = fs.readdirSync(appDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(appDir, entry.name);
    const pkgCandidate = path.join(candidate, 'package.json');
    if (fs.existsSync(pkgCandidate)) {
      return candidate;
    }
  }
  throw new Error('Could not find package.json in appDir or its direct subdirectories.');
}

function findIndexHtmlUnder(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const loc = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const res = findIndexHtmlUnder(loc);
      if (res) return res;
    } else if (entry.isFile() && entry.name.toLowerCase() === 'index.html') {
      return loc;
    }
  }
  return null;
}

function findBuiltIndexHtml(projectDir) {
  const candidates = [
    path.join(projectDir, 'dist'),
    path.join(projectDir, 'build')
  ];

  for (const base of candidates) {
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
      continue;
    }
    const indexPath = findIndexHtmlUnder(base);
    if (indexPath) {
      return indexPath;
    }
  }

  throw new Error('Could not find dist/build index.html after npm run build.');
}

function isExternalUrl(url) {
  if (!url) return false;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:');
}

function resolveAssetPath(distRoot, url) {
  let p = url.trim();
  p = p.replace(/^\//, '');
  p = p.replace(/^\.\//, '');
  return path.join(distRoot, p);
}

function inlineHeadAssets(document, distRoot) {
  const head = document.head || document.createElement('head');

  // CSS: inline local stylesheets, keep external ones
  const linkNodes = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'));
  for (const link of linkNodes) {
    const href = link.getAttribute('href');
    if (!href) continue;

    if (isExternalUrl(href)) {
      if (link.parentNode !== head) {
        head.appendChild(link.cloneNode(true));
        link.parentNode.removeChild(link);
      }
      continue;
    }

    const assetPath = resolveAssetPath(distRoot, href);
    if (!fs.existsExistsSyncSafe(assetPath)) {
      console.warn(`CSS asset not found for href=${href} at ${assetPath}`);
      continue;
    }

    const css = fs.readFileSync(assetPath, 'utf8');
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    head.appendChild(styleEl);
    link.parentNode.removeChild(link);
  }

  // JS: inline local bundles, keep external ones
  const scriptNodes = Array.from(document.querySelectorAll('script[src]'));
  for (const script of scriptNodes) {
    const src = script.getAttribute('src');
    if (!src) continue;

    if (isExternalUrl(src)) {
      if (script.parentNode !== head) {
        head.appendChild(script.cloneNode(true));
        script.parentNode.removeChild(script);
      }
      continue;
    }

    const assetPath = resolveAssetPath(distRoot, src);
    if (!fs.existsExistsSyncSafe(assetPath)) {
      console.warn(`JS asset not found for src=${src} at ${assetPath}`);
      continue;
    }

    const js = fs.readFileSync(assetPath, 'utf8');
    const inlineScript = document.createElement('script');
    const type = script.getAttribute('type');
    if (type) {
      inlineScript.setAttribute('type', type);
    } else {
      inlineScript.setAttribute('type', 'module');
    }
    if (script.hasAttribute('defer')) {
      inlineScript.setAttribute('defer', 'defer');
    }
    inlineScript.textContent = js;
    head.appendChild(inlineScript);
    script.parentNode.removeChild(script);
  }

  return head.innerHTML;
}

// Helper: fs.existsSync but wrapped for try/catch
fs.existsExistsSyncSafe = function (p) {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
};

function extractTextFromHtml(html) {
  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    return (doc.body && doc.body.textContent ? doc.body.textContent : '').replace(/\s+/g, ' ').trim();
  } catch (e) {
    return '';
  }
}

/**
 * Classic builder: everything in one block for maximum fidelity.
 */
function buildSectionsClassic(document) {
  const body = document.body;
  if (!body) {
    throw new Error('No <body> element in built index.html.');
  }

  let rootElement =
    body.querySelector('#root') ||
    body.querySelector('app-root');

  let html;
  if (rootElement) {
    html = rootElement.outerHTML;
  } else {
    html = body.innerHTML.trim();
  }

  return [
    {
      id: rootElement ? rootElement.id || '' : '',
      class: rootElement ? (rootElement.getAttribute('class') || '') : '',
      html: html,
      type: 'app_root',
      builder: {}
    }
  ];
}

/**
 * Divi builder: split into semantic sections.
 */
function buildSectionsDivi(document) {
  const body = document.body;
  if (!body) {
    throw new Error('No <body> element in built index.html.');
  }

  let candidates = Array.from(body.querySelectorAll('section, main, header, footer'));

  if (candidates.length === 0) {
    candidates = Array.from(body.children || []);
  }

  if (candidates.length === 0) {
    candidates = [body];
  }

  const sections = [];
  const llmSections = [];

  candidates.forEach((el, idx) => {
    const id = el.id || '';
    const className = el.getAttribute('class') || '';
    const html = el.outerHTML;
    const text = extractTextFromHtml(html).slice(0, 1000);
    const snippet = html.slice(0, 1000);

    let type = 'generic';
    const lowerText = text.toLowerCase();
    if (lowerText.includes('pricing') || lowerText.includes('plans') || lowerText.includes('per month')) {
      type = 'pricing';
    } else if (lowerText.includes('faq') || lowerText.includes('frequently asked questions')) {
      type = 'faq';
    } else if (lowerText.includes('contact') || lowerText.includes('get in touch')) {
      type = 'contact';
    } else if (lowerText.includes('testimonials') || lowerText.includes('what our clients say')) {
      type = 'testimonials';
    } else if (lowerText.includes('services')) {
      type = 'services';
    } else if (lowerText.includes('about')) {
      type = 'about';
    } else if (lowerText.includes('hero') || lowerText.includes('welcome') || lowerText.includes('we help')) {
      type = 'hero';
    }

    sections.push({
      id,
      class: className,
      html,
      type,
      builder: {}
    });

    llmSections.push({
      index: idx,
      id,
      classes: className,
      type,
      text,
      htmlSnippet: snippet
    });
  });

  return { sections, llmSections };
}

/**
 * Call on-repo LLM (Python + transformers) to classify Divi module types.
 */
function classifySectionsWithLLM(llmSections, builder) {
  if (!llmSections || llmSections.length === 0) {
    return [];
  }

  console.log('Invoking local LLM classifier for sections...');

  const payload = {
    builder,
    sections: llmSections
  };

  const proc = spawnSync('python', ['scripts/llm_classifier.py'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });

  if (proc.error) {
    console.error('Error running llm_classifier.py:', proc.error);
    return [];
  }

  if (proc.status !== 0) {
    console.error('llm_classifier.py non-zero exit code:', proc.status);
    console.error('stderr:', proc.stderr);
    return [];
  }

  let result;
  try {
    result = JSON.parse(proc.stdout);
  } catch (e) {
    console.error('Failed to parse LLM output as JSON:', e);
    console.error('Raw output:', proc.stdout);
    return [];
  }

  if (!result || !Array.isArray(result.results)) {
    console.error('LLM output missing results array.');
    return [];
  }

  return result.results;
}

function extractLayoutFromBuiltIndex(indexPath, builder) {
  const html = fs.readFileSync(indexPath, 'utf8');
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const distRoot = path.dirname(indexPath);

  const headHtml = inlineHeadAssets(document, distRoot);
  const bodyClass =
    (document.body && document.body.getAttribute('class')) || '';

  let sections = [];
  let llmSections = [];

  if (builder === 'divi') {
    const built = buildSectionsDivi(document);
    sections = built.sections;
    llmSections = built.llmSections;
  } else {
    sections = buildSectionsClassic(document);
    llmSections = [];
  }

  return { headHtml, bodyClass, sections, llmSections };
}

async function postError(message) {
  if (!gCallbackUrl || !gJobId || !gJobSecret) {
    console.error('Error:', message);
    return;
  }

  try {
    await axios.post(
      gCallbackUrl,
      {
        job_id: gJobId,
        secret: gJobSecret,
        error: message
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
  } catch (err) {
    console.error('Failed to send error callback:', err.message || err);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const jobId = args.jobId;
  const jobSecret = args.jobSecret;
  const builder = args.builder || 'divi';
  const appDir = args.appDir || './app';
  const callbackUrl = args.callbackUrl;
  const pageTitle = args.pageTitle || '';
  const slug = args.slug || '';

  if (!jobId || !jobSecret || !callbackUrl) {
    throw new Error('job-id, job-secret, and callback-url are required.');
  }

  gJobId = jobId;
  gJobSecret = jobSecret;
  gCallbackUrl = callbackUrl;

  const projectDir = findProjectDir(appDir);

  try {
    runCommand(projectDir, 'npm ci');
  } catch (e) {
    console.warn('npm ci failed, falling back to npm install');
    runCommand(projectDir, 'npm install');
  }

  runCommand(projectDir, 'npm run build');

  const indexHtmlPath = findBuiltIndexHtml(projectDir);
  console.log(`Using built index.html at: ${indexHtmlPath}`);

  const { headHtml, bodyClass, sections, llmSections } =
    extractLayoutFromBuiltIndex(indexHtmlPath, builder);

  let builderMetaByIndex = [];

  if (builder === 'divi' && llmSections.length > 0) {
    builderMetaByIndex = classifySectionsWithLLM(llmSections, builder);
  }

  const builderMetaMap = {};
  builderMetaByIndex.forEach((entry) => {
    if (!entry || typeof entry.index !== 'number') return;
    builderMetaMap[entry.index] = {
      module_type: entry.module_type || 'code',
      params: entry.params && typeof entry.params === 'object' ? entry.params : {}
    };
  });

  const finalSections = sections.map((section, idx) => {
    const builderMeta = builderMetaMap[idx] || {};
    const modType = builderMeta.module_type || 'code';
    const params = builderMeta.params || {};

    const builderField =
      builder === 'divi'
        ? { divi: { module_type: modType, params } }
        : {};

    return {
      id: section.id,
      class: section.class,
      html: section.html,
      type: section.type,
      builder: builderField
    };
  });

  const layout = {
    head_html: headHtml,
    body_class: bodyClass,
    sections: finalSections
  };

  const payload = {
    job_id: jobId,
    secret: jobSecret,
    layout: layout,
    page_title: pageTitle,
    slug: slug,
    builder: builder
  };

  console.log('Posting layout back to WordPress callback...');
  await axios.post(callbackUrl, payload, {
    headers: { 'Content-Type': 'application/json' }
  });

  console.log('Done.');
}

main().catch(async (err) => {
  console.error('Worker error:', err.message || err);
  await postError(err.message || String(err));
  process.exit(1);
});
