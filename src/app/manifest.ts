import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { planeForHost } from "@/config";
import { THEME_COLOR_LIGHT } from "@/lib/theme";

/**
 * The web-app manifest (decision 15 / ARC-25, Stage A): the member app on
 * the app host is installable — standalone display, `/home` as the start
 * URL, an explicit id, regular + maskable icons, colours from the theme
 * tokens (the dark theme colour rides on the root layout's
 * <meta name="theme-color" media=…>). It is a request-time route on
 * purpose: the ops host (platform plane, MFA-mandatory admin) must stay
 * un-installable, so the manifest 404s there — decided by `planeForHost`
 * from src/config (INV-D2), never a hardcoded hostname. The portal gets
 * its own manifest in Phase 3 (CP3).
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const host = (await headers()).get("host") ?? "";
  if (planeForHost(host) !== "app") notFound();
  return {
    id: "/app",
    name: "Fortleva",
    short_name: "Fortleva",
    description: "Clients, projects, tasks and time — the agency operating system.",
    start_url: "/home",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: THEME_COLOR_LIGHT,
    theme_color: THEME_COLOR_LIGHT,
    lang: "sv",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
