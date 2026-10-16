// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Fabrintek Engenharia Digital Ltda

// The status page, at the monitor's own address. The page is Chirp's: it is
// written and published with the rest of usechirp.app, and the Worker fetches
// it from there at run time, as it does the list of servers, so there is one
// page and this repository imports none of it. The page's CSP allows scripts,
// styles and images from 'self' only, so its assets are passed through from
// here too; the rest of the site's links are pointed back at usechirp.app.

/** Where the page lives on the site, for a path the Worker serves it at; null
 * for a path that is not the page or one of its assets. */
export function upstreamPath(pathname: string): string | null {
  if (pathname === "/" || pathname === "/index.html") return "/status/";
  if (pathname === "/favicon.svg") return pathname;
  if (/^\/assets\/[A-Za-z0-9._/-]+$/.test(pathname) && !pathname.includes("..")) return pathname;
  return null;
}

/** A link in the page, as it must read when the page is served from here:
 * the page itself and its assets stay on this host, any other path on the
 * site goes to the site. */
export function rewriteHref(href: string, siteOrigin: string): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const m = /^\/status(?:\/|(?=[?#]|$))(.*)$/.exec(href);
  if (m) return "/" + m[1];
  if (href === "/favicon.svg" || href.startsWith("/favicon.svg?") || href.startsWith("/assets/")) return href;
  return siteOrigin.replace(/\/+$/, "") + href;
}
