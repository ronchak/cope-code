export const BROWSER_PRODUCTS = ["edge", "chrome"] as const;

export type BrowserProduct = typeof BROWSER_PRODUCTS[number];

export const BROWSER_CONTRACT_VERSION = "cope-visible-browser/v1" as const;

export interface BrowserProductPresentation {
  readonly productName: string;
  readonly shortName: string;
  readonly executableName: string;
  readonly supportTrack: "established-compatibility-target" | "preview-candidate";
  readonly certificationStatus: "live-evidence-pending" | "offline-evidence-only";
}

const PRESENTATION: Readonly<Record<BrowserProduct, BrowserProductPresentation>> = Object.freeze({
  edge: {
    productName: "Microsoft Edge Stable",
    shortName: "Edge",
    executableName: "msedge.exe",
    supportTrack: "established-compatibility-target",
    certificationStatus: "live-evidence-pending",
  },
  chrome: {
    productName: "Google Chrome Stable",
    shortName: "Chrome",
    executableName: "chrome.exe",
    supportTrack: "preview-candidate",
    certificationStatus: "offline-evidence-only",
  },
});

export function browserProductPresentation(product: BrowserProduct): BrowserProductPresentation {
  return PRESENTATION[product];
}

export function isBrowserProduct(value: unknown): value is BrowserProduct {
  return value === "edge" || value === "chrome";
}
