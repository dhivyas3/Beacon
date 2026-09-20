/**
 * Runs inside the page and returns everything the checks need in one round trip: images, links,
 * references to other resources, SEO metadata and forms.
 *
 * This is deliberately a plain JavaScript string rather than a TypeScript function. Bundlers and
 * `tsx` can inject helpers into functions, and those helpers do not exist in the browser.
 */
export const SNAPSHOT_SCRIPT = String.raw`(() => {
  const LIMITS = { images: 500, anchors: 5000, references: 1000, backgrounds: 300, forms: 50 };

  const abs = (value) => {
    if (value === null || value === undefined || value === '') return null;
    try {
      const url = new URL(value, document.baseURI);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (e) {
      return null;
    }
  };

  const unique = (el) => {
    if (!el.id) return false;
    try {
      return document.querySelectorAll('#' + CSS.escape(el.id)).length === 1;
    } catch (e) {
      return false;
    }
  };

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < 6) {
      if (unique(node)) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  };

  const attr = (el, name) => (el.hasAttribute(name) ? el.getAttribute(name) : null);

  const srcsetCandidates = (value) => {
    if (!value) return [];
    return value
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter((candidate) => candidate && !candidate.startsWith('data:'))
      .map(abs)
      .filter(Boolean);
  };

  // Images
  const images = [];
  for (const img of Array.from(document.images).slice(0, LIMITS.images)) {
    const candidates = srcsetCandidates(img.getAttribute('srcset'));
    const picture = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
    if (picture) {
      for (const source of Array.from(picture.querySelectorAll('source'))) {
        for (const candidate of srcsetCandidates(source.getAttribute('srcset'))) candidates.push(candidate);
      }
    }
    const rawSrc = attr(img, 'src');
    images.push({
      selector: cssPath(img),
      rawSrc: rawSrc,
      src: abs(rawSrc),
      currentSrc: img.currentSrc ? abs(img.currentSrc) : null,
      alt: attr(img, 'alt'),
      naturalWidth: img.naturalWidth,
      complete: img.complete,
      loading: img.loading || null,
      width: img.width,
      height: img.height,
      decorative:
        img.getAttribute('aria-hidden') === 'true' ||
        img.getAttribute('role') === 'presentation' ||
        img.getAttribute('role') === 'none',
      srcset: Array.from(new Set(candidates)),
    });
  }

  // CSS background images
  const backgrounds = [];
  const elements = Array.from(document.querySelectorAll('body, body *')).slice(0, 4000);
  for (const el of elements) {
    if (backgrounds.length >= LIMITS.backgrounds) break;
    const value = getComputedStyle(el).backgroundImage;
    if (!value || value === 'none') continue;
    for (const match of value.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
      const url = abs(match[2]);
      if (url) backgrounds.push({ selector: cssPath(el), url: url });
    }
  }

  // Links
  const anchors = [];
  for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, LIMITS.anchors)) {
    anchors.push({
      rawHref: a.getAttribute('href'),
      href: abs(a.getAttribute('href')),
      text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      selector: cssPath(a),
      rel: attr(a, 'rel'),
    });
  }

  // Other references: scripts, stylesheets, canonical, frames, media, form actions, social images
  const references = [];
  const pushRef = (el, tag, name, value) => {
    if (references.length >= LIMITS.references) return;
    const url = abs(value);
    if (url) references.push({ tag: tag, attr: name, url: url, selector: cssPath(el), rel: attr(el, 'rel') });
  };
  for (const el of Array.from(document.querySelectorAll('script[src]'))) pushRef(el, 'script', 'src', el.getAttribute('src'));
  for (const el of Array.from(document.querySelectorAll('link[href]'))) pushRef(el, 'link', 'href', el.getAttribute('href'));
  for (const el of Array.from(document.querySelectorAll('iframe[src], embed[src]'))) pushRef(el, el.tagName.toLowerCase(), 'src', el.getAttribute('src'));
  for (const el of Array.from(document.querySelectorAll('video[src], audio[src], source[src]'))) pushRef(el, el.tagName.toLowerCase(), 'src', el.getAttribute('src'));
  for (const el of Array.from(document.querySelectorAll('video[poster]'))) pushRef(el, 'video', 'poster', el.getAttribute('poster'));
  for (const el of Array.from(document.querySelectorAll('object[data]'))) pushRef(el, 'object', 'data', el.getAttribute('data'));
  for (const el of Array.from(document.querySelectorAll('form[action]'))) pushRef(el, 'form', 'action', el.getAttribute('action'));
  for (const el of Array.from(document.querySelectorAll('meta[property="og:image"], meta[property="og:url"], meta[name="twitter:image"]'))) {
    pushRef(el, 'meta', 'content', el.getAttribute('content'));
  }

  // SEO metadata
  const meta = (selector) => {
    const el = document.querySelector(selector);
    return el ? (el.getAttribute('content') || '') : null;
  };
  const head = document.head;
  const titles = head ? Array.from(head.querySelectorAll('title')) : [];
  const canonicals = Array.from(document.querySelectorAll('link[rel~="canonical"]'));
  const ogTags = {};
  for (const el of Array.from(document.querySelectorAll('meta[property^="og:"]'))) {
    ogTags[el.getAttribute('property')] = el.getAttribute('content') || '';
  }

  // Forms
  const forms = [];
  for (const form of Array.from(document.forms).slice(0, LIMITS.forms)) {
    const fields = Array.from(form.elements)
      .filter((el) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button')
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        name: el.getAttribute('name'),
        required: !!el.required,
        selector: cssPath(el),
      }));
    const hasSubmit = !!form.querySelector('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]');
    const scope = form.closest('section, div, main') || form;
    const captchaSelector = '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], [class*="captcha" i], [id*="captcha" i]';
    forms.push({
      selector: cssPath(form),
      rawAction: attr(form, 'action'),
      action: abs(form.getAttribute('action') || location.href),
      method: (form.getAttribute('method') || 'get').toLowerCase(),
      hasSubmit: hasSubmit,
      hasCaptcha: !!(form.querySelector(captchaSelector) || scope.querySelector(captchaSelector)),
      noValidate: form.noValidate,
      fields: fields,
    });
  }

  return {
    title: titles.length > 0 ? (titles[0].textContent || '').trim() : null,
    titleCount: titles.length,
    metaDescription: meta('meta[name="description" i]'),
    canonical: canonicals.length > 0 ? abs(canonicals[0].getAttribute('href')) : null,
    canonicalCount: canonicals.length,
    robotsMeta: meta('meta[name="robots" i]'),
    lang: document.documentElement.getAttribute('lang'),
    h1Count: document.querySelectorAll('h1').length,
    ogTags: ogTags,
    images: images,
    backgrounds: backgrounds,
    anchors: anchors,
    references: references,
    forms: forms,
  };
})()`;

/** Scrolls down in steps so lazy-loaded content loads, then back to the top. */
export const SCROLL_SCRIPT = String.raw`(async () => {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  let y = 0;
  for (let i = 0; i < 60; i += 1) {
    window.scrollTo(0, y);
    await pause(120);
    const bottom = document.documentElement.scrollHeight;
    if (y + window.innerHeight >= bottom) break;
    y += step;
  }
  window.scrollTo(0, document.documentElement.scrollHeight);
  await pause(300);
  window.scrollTo(0, 0);
  return true;
})()`;
