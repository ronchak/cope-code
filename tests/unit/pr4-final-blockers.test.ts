import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, Frame, Locator, Page } from "playwright-core";

import {
  CopilotBrowserAdapter,
  type BrowserStateInspection,
} from "../../src/browser/copilot-browser-adapter.js";
import {
  classifyCopilotPage,
  type CopilotPageState,
} from "../../src/browser/classifier.js";
import { ContextSemanticPage } from "../../src/browser/context-semantic-page.js";
import {
  createBaselineCopilotUiContract,
  type BrowserWaitConfig,
  type CopilotBrowserAdapterConfig,
} from "../../src/browser/config.js";
import type {
  CopilotPageObservation,
  CopilotSignal,
  ElementSnapshot,
  GroupSnapshot,
  LocatorGroup,
  SemanticPage,
} from "../../src/browser/contracts.js";
import { waitForStableManualReadiness } from "../../src/browser/manual-readiness.js";
import { PlaywrightSemanticPage } from "../../src/browser/playwright-semantic-page.js";

const SIGNALS: readonly CopilotSignal[] = [
  "shell",
  "conversation",
  "composer",
  "send",
  "responses",
  "user-messages",
  "streaming",
  "identity",
  "protection",
  "signed-out",
  "mfa",
  "consent",
  "throttled",
  "service-error",
  "modal",
];

const waits: BrowserWaitConfig = {
  actionMs: 1_000,
  submissionConfirmationMs: 2_000,
  responseMs: 5_000,
  manualReadinessMs: 5_000,
  pollMs: 250,
  stableSamples: 3,
  minimumStableMs: 750,
};

const locatorQuorum = Object.fromEntries(
  SIGNALS.map((signal) => [signal, false]),
) as Readonly<Record<CopilotSignal, boolean>>;

test("manual Microsoft popup states discard stale unsafe-host samples", async () => {
  let now = 0;
  let calls = 0;
  const states: readonly BrowserStateInspection[] = [
    inspection("unapproved-host", "HOST_NOT_APPROVED"),
    inspection("unapproved-host", "HOST_NOT_APPROVED"),
    inspection("unapproved-host", "HOST_NOT_APPROVED"),
    inspection("blocking-modal", "UNEXPECTED_BLOCKING_MODAL"),
    inspection("blocking-modal", "UNEXPECTED_BLOCKING_MODAL"),
    inspection("blocking-modal", "UNEXPECTED_BLOCKING_MODAL"),
    inspection("blocking-modal", "UNEXPECTED_BLOCKING_MODAL"),
    inspection("blocking-modal", "UNEXPECTED_BLOCKING_MODAL"),
    inspection("ready", "READY"),
  ];

  const result = await waitForStableManualReadiness(
    async () => states[Math.min(calls++, states.length - 1)]!,
    waits,
    waits.manualReadinessMs,
    undefined,
    {
      monotonicNow: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    },
  );

  assert.equal(result.classification.state, "ready");
  assert.equal(calls, states.length);
  assert.equal(now, waits.pollMs * (states.length - 1));
});

test("a native dialog on an external Microsoft auth host is bounded before host gating", () => {
  const identity = "Synthetic Work Account";
  const contract = createBaselineCopilotUiContract(identity);
  const snapshots = Object.fromEntries(
    SIGNALS.map((signal) => [
      signal,
      groupSnapshot(signal, signal === "modal", false),
    ]),
  ) as Record<CopilotSignal, GroupSnapshot>;
  const observation: CopilotPageObservation = {
    url: "https://login.microsoftonline.com/common/oauth2/authorize?client_id=synthetic",
    ...snapshots,
  };

  const classification = classifyCopilotPage(observation, contract, {
    entryUrl: "https://m365.cloud.microsoft/chat",
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    expectedIdentity: identity,
    requireProtectionIndicator: false,
  });

  assert.equal(classification.state, "blocking-modal");
  assert.equal(classification.diagnosticCode, "NATIVE_BROWSER_DIALOG_DETECTED");
});

test("a returned chat remains selected while the completed auth popup stays open", async () => {
  const chat = new NavigationPage("https://m365.cloud.microsoft/chat/conversation/synthetic");
  const authentication = new NavigationPage(
    "https://login.microsoftonline.com/common/oauth2/authorize?client_id=synthetic",
  );
  const context = new NavigationContext([chat, authentication]);
  const tracked = new ContextSemanticPage(
    context.asContext(),
    {
      entryUrl: "https://m365.cloud.microsoft/chat",
      approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
      manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
    },
    chat.asPage(),
    1_000,
  );

  assert.equal(await tracked.currentUrl(), authentication.currentUrl);
  chat.navigate(chat.currentUrl);
  assert.equal(await tracked.currentUrl(), chat.currentUrl);
  assert.equal(await tracked.currentUrl(), chat.currentUrl);
  assert.equal(authentication.closed, false);
});

test("an in-place hydrated chat displaces a completed auth popup without navigation", async () => {
  const chat = new NavigationPage("https://m365.cloud.microsoft/chat/conversation/synthetic");
  const authentication = new NavigationPage(
    "https://login.microsoftonline.com/common/oauth2/authorize?client_id=synthetic",
  );
  const context = new NavigationContext([chat, authentication]);
  const config = {
    entryUrl: "https://m365.cloud.microsoft/chat",
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
    uiContract: createBaselineCopilotUiContract("Synthetic Work Account"),
  };
  const tracked = new ContextSemanticPage(
    context.asContext(),
    config,
    chat.asPage(),
    1_000,
  );

  assert.equal(await tracked.currentUrl(), authentication.currentUrl);
  assert.equal(await tracked.currentUrl(), authentication.currentUrl);

  chat.composerEnabled = true;
  assert.equal(await tracked.currentUrl(), chat.currentUrl);
  assert.equal(await tracked.currentUrl(), chat.currentUrl);
  assert.equal(authentication.closed, false);
});

test("an already-actionable chat cannot displace a newer active auth popup", async () => {
  const chat = new NavigationPage("https://m365.cloud.microsoft/chat/conversation/synthetic");
  chat.composerEnabled = true;
  const authentication = new NavigationPage(
    "https://login.microsoftonline.com/common/oauth2/authorize?client_id=synthetic",
  );
  const context = new NavigationContext([chat, authentication]);
  const tracked = new ContextSemanticPage(
    context.asContext(),
    trackedPageConfig(),
    chat.asPage(),
    1_000,
  );

  assert.equal(await tracked.currentUrl(), authentication.currentUrl);
  assert.equal(await tracked.currentUrl(), authentication.currentUrl);
});

test("a sticky native dialog prevents retiring the auth popup", async () => {
  const chat = new NavigationPage("https://m365.cloud.microsoft/chat/conversation/synthetic");
  const authentication = new NavigationPage(
    "https://login.microsoftonline.com/common/oauth2/authorize?client_id=synthetic",
  );
  const context = new NavigationContext([chat, authentication]);
  const tracked = new ContextSemanticPage(
    context.asContext(),
    trackedPageConfig(),
    chat.asPage(),
    1_000,
  );

  assert.equal(await tracked.currentUrl(), authentication.currentUrl);
  chat.composerEnabled = true;
  authentication.emitDialog();

  assert.equal(await tracked.currentUrl(), authentication.currentUrl);
});

test("auth navigation during the composer probe prevents a stale handoff", async () => {
  const chat = new NavigationPage("https://m365.cloud.microsoft/chat/conversation/synthetic");
  const authentication = new NavigationPage(
    "https://login.microsoftonline.com/common/oauth2/authorize?client_id=synthetic",
  );
  const context = new NavigationContext([chat, authentication]);
  const tracked = new ContextSemanticPage(
    context.asContext(),
    trackedPageConfig(),
    chat.asPage(),
    1_000,
  );

  assert.equal(await tracked.currentUrl(), authentication.currentUrl);
  chat.composerEnabled = true;
  chat.onComposerProbe = () => {
    chat.onComposerProbe = undefined;
    authentication.navigate(
      "https://login.microsoftonline.com/common/oauth2/authorize?client_id=synthetic&step=mfa",
    );
  };

  assert.equal(await tracked.currentUrl(), authentication.currentUrl);
  assert.match(authentication.currentUrl, /step=mfa/u);
});

test("a new auth popup on the post-confirm refresh is never swept stale", async () => {
  const chat = new NavigationPage("https://m365.cloud.microsoft/chat/conversation/synthetic");
  const authenticationA = new NavigationPage(
    "https://login.microsoftonline.com/common/oauth2/authorize?client_id=synthetic&popup=a",
  );
  const authenticationB = new NavigationPage(
    "https://login.microsoftonline.com/common/oauth2/authorize?client_id=synthetic&popup=b",
  );
  const context = new NavigationContext([chat, authenticationA]);
  const tracked = new ContextSemanticPage(
    context.asContext(),
    trackedPageConfig(),
    chat.asPage(),
    1_000,
  );

  assert.equal(await tracked.currentUrl(), authenticationA.currentUrl);
  chat.composerEnabled = true;
  let pageReads = 0;
  context.onPages = () => {
    pageReads += 1;
    if (pageReads === 3) context.pageList.push(authenticationB);
  };

  assert.equal(await tracked.currentUrl(), authenticationB.currentUrl);
  assert.equal(await tracked.currentUrl(), authenticationB.currentUrl);
});

test("a newer auth popup recaptures the chat baseline for its own episode", async () => {
  const chatA = new NavigationPage("https://m365.cloud.microsoft/chat/conversation/first");
  const authenticationA = new NavigationPage(
    "https://login.microsoftonline.com/common/oauth2/authorize?client_id=synthetic&popup=a",
  );
  const context = new NavigationContext([chatA, authenticationA]);
  const tracked = new ContextSemanticPage(
    context.asContext(),
    trackedPageConfig(),
    chatA.asPage(),
    1_000,
  );

  assert.equal(await tracked.currentUrl(), authenticationA.currentUrl);

  const chatB = new NavigationPage("https://m365.cloud.microsoft/chat/conversation/second");
  chatB.composerEnabled = true;
  const authenticationB = new NavigationPage(
    "https://login.microsoftonline.com/common/oauth2/authorize?client_id=synthetic&popup=b",
  );
  context.pageList.splice(0, context.pageList.length, authenticationA, chatB, authenticationB);

  assert.equal(await tracked.currentUrl(), authenticationB.currentUrl);
  assert.equal(await tracked.currentUrl(), authenticationB.currentUrl);
});

test("a retired auth popup with a new native dialog is reselected before disclosure", async () => {
  const chat = new NavigationPage("https://m365.cloud.microsoft/chat/conversation/synthetic");
  const authentication = new NavigationPage(
    "https://login.microsoftonline.com/common/oauth2/authorize?client_id=synthetic",
  );
  const context = new NavigationContext([chat, authentication]);
  const selectionConfig = trackedPageConfig();
  const tracked = new ContextSemanticPage(
    context.asContext(),
    selectionConfig,
    chat.asPage(),
    1_000,
  );

  assert.equal(await tracked.currentUrl(), authentication.currentUrl);
  chat.composerEnabled = true;
  assert.equal(await tracked.currentUrl(), chat.currentUrl);

  authentication.emitDialog();
  assert.equal(await tracked.currentUrl(), authentication.currentUrl);

  const adapter = new CopilotBrowserAdapter(tracked, {
    ...selectionConfig,
    expectedIdentity: "Synthetic Work Account",
    requireProtectionIndicator: false,
    maxMessageChars: 10_000,
    maxResponseChars: 10_000,
    waits,
  });
  const receipt = await adapter.submit({
    taskId: "late-dialog-task",
    turnId: "late-dialog-turn",
    submissionId: "late-dialog-submission",
    content: "This prompt must not be disclosed.",
  });

  assert.equal(receipt.status, "not-submitted");
  assert.equal(receipt.diagnosticCode, "NATIVE_BROWSER_DIALOG_DETECTED");
  assert.equal(chat.composerFillCalls, 0);
});

test("baseline identity evidence is limited to explicit account and profile controls", () => {
  const identity = createBaselineCopilotUiContract("Ronak Chakraborty").groups.identity;

  assert.equal(identity.candidates.length, 1);
  assert.equal(identity.candidates[0]?.kind, "css");
  if (identity.candidates[0]?.kind !== "css") return;
  for (const selector of identity.candidates[0].selector.split(",")) {
    assert.match(
      selector,
      /mectrl|mecontrol|me-control|account-control|account-menu|profile|persona/iu,
      selector,
    );
  }
});

function trackedPageConfig() {
  return {
    entryUrl: "https://m365.cloud.microsoft/chat",
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
    uiContract: createBaselineCopilotUiContract("Synthetic Work Account"),
  } as const;
}

test("composer actionability follows the same later candidate that fill will use", async () => {
  const disabled = new CandidateItem(false, "disabled draft");
  const enabled = new CandidateItem(true, "usable draft");
  const page = new CandidatePage(disabled, enabled);
  const semantic = new PlaywrightSemanticPage(page.asPage());
  const group: LocatorGroup = {
    signal: "composer",
    candidates: [
      { kind: "role", role: "textbox", name: "Message" },
      { kind: "placeholder", placeholder: "Message" },
    ],
    minimumCandidateMatches: 1,
    maximumElements: 5,
    capture: "value-and-text",
  };

  const snapshot = await semantic.snapshot(group);
  assert.equal(snapshot.matchedCandidates, 2);
  assert.equal(snapshot.visibleElements, 2);
  assert.equal(snapshot.enabledElements, 1);
  assert.equal(snapshot.elements[0]?.value, "usable draft");

  await semantic.fill(group, "new prompt", () => {});
  assert.equal(disabled.filledValue, undefined);
  assert.equal(enabled.filledValue, "new prompt");
});

test("a recoverable popup blocks submission without any browser action", async () => {
  const page = new BlockingSemanticPage();
  const config: CopilotBrowserAdapterConfig = {
    entryUrl: "https://m365.cloud.microsoft/chat",
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
    uiContract: createBaselineCopilotUiContract("Synthetic Work Account"),
    expectedIdentity: "Synthetic Work Account",
    requireProtectionIndicator: true,
    maxMessageChars: 10_000,
    maxResponseChars: 10_000,
    waits,
  };
  const adapter = new CopilotBrowserAdapter(page, config);

  const receipt = await adapter.submit({
    taskId: "popup-task",
    turnId: "popup-turn",
    submissionId: "popup-submission",
    content: "This must never reach the composer while the popup is visible.",
  });

  assert.equal(receipt.status, "not-submitted");
  assert.equal(receipt.diagnosticCode, "UNEXPECTED_BLOCKING_MODAL");
  assert.equal(page.fillCalls, 0);
  assert.equal(page.activationCalls, 0);
});

function inspection(
  state: CopilotPageState,
  diagnosticCode: string,
): BrowserStateInspection {
  return {
    classification: { state, retryable: state === "ready", diagnosticCode },
    diagnostic: {
      uiContractVersion: "copilot-ui/v1:m365-2026-07",
      state,
      diagnosticCode,
      locatorQuorum,
    },
  };
}

function groupSnapshot(
  signal: CopilotSignal,
  visible: boolean,
  enabled: boolean,
  text = "",
  value = "",
): GroupSnapshot {
  const elements: readonly ElementSnapshot[] = visible
    ? [{ visible: true, enabled, text, value, accessibleLabel: text }]
    : [];
  return {
    signal,
    matchedCandidates: visible ? 1 : 0,
    visibleElements: elements.length,
    enabledElements: elements.filter((element) => element.enabled).length,
    elements,
  };
}

class NavigationPage {
  public closed = false;
  public composerEnabled = false;
  public composerFillCalls = 0;
  public onComposerProbe: (() => void) | undefined;
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly #mainFrame = {} as Frame;

  public constructor(public currentUrl: string) {}

  public url(): string { return this.currentUrl; }
  public isClosed(): boolean { return this.closed; }
  public setDefaultTimeout(_milliseconds: number): void {}
  public setDefaultNavigationTimeout(_milliseconds: number): void {}
  public async bringToFront(): Promise<void> {}
  public mainFrame(): Frame { return this.#mainFrame; }
  public getByRole(role: string): Locator {
    return role === "textbox" ? this.#composerLocator() : this.#emptyLocator();
  }
  public getByPlaceholder(): Locator { return this.#composerLocator(); }
  public getByLabel(): Locator { return this.#composerLocator(); }
  public locator(selector: string): Locator {
    return /textarea|contenteditable/iu.test(selector)
      ? this.#composerLocator()
      : this.#emptyLocator();
  }
  public on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }
  public navigate(value: string): void {
    this.currentUrl = value;
    for (const listener of this.#listeners.get("framenavigated") ?? []) {
      listener(this.#mainFrame);
    }
  }
  public emitDialog(): void {
    for (const listener of this.#listeners.get("dialog") ?? []) listener({});
  }
  #composerLocator(): Locator {
    return new CandidateCollection(
      new CandidateItem(
        this.composerEnabled,
        "",
        () => this.onComposerProbe?.(),
        () => { this.composerFillCalls += 1; },
      ),
    ) as unknown as Locator;
  }
  #emptyLocator(): Locator {
    return new CandidateCollection() as unknown as Locator;
  }
  public asPage(): Page { return this as unknown as Page; }
}

class NavigationContext {
  readonly #listeners: Array<(page: Page) => void> = [];
  public readonly pageList: NavigationPage[];
  public onPages: (() => void) | undefined;

  public constructor(pages: readonly NavigationPage[]) {
    this.pageList = [...pages];
  }

  public pages(): Page[] {
    this.onPages?.();
    return this.pageList.map((page) => page.asPage());
  }
  public on(event: string, listener: (page: Page) => void): this {
    if (event === "page") this.#listeners.push(listener);
    return this;
  }
  public asContext(): BrowserContext { return this as unknown as BrowserContext; }
}

class CandidateItem {
  public filledValue: string | undefined;

  public constructor(
    private readonly enabled: boolean,
    private readonly currentValue: string,
    private readonly onEnabledProbe?: () => void,
    private readonly onFill?: () => void,
  ) {}

  public async isVisible(): Promise<boolean> { return true; }
  public async isEnabled(): Promise<boolean> {
    this.onEnabledProbe?.();
    return this.enabled;
  }
  public async innerText(): Promise<string> { return "Message"; }
  public async getAttribute(name: string): Promise<string | null> {
    return name === "aria-label" ? "Message" : null;
  }
  public async inputValue(): Promise<string> { return this.currentValue; }
  public async fill(value: string): Promise<void> {
    this.onFill?.();
    this.filledValue = value;
  }
}

class CandidateCollection {
  public constructor(private readonly item?: CandidateItem) {}
  public async count(): Promise<number> { return this.item === undefined ? 0 : 1; }
  public nth(_index: number): Locator {
    if (this.item === undefined) throw new RangeError("No synthetic locator item");
    return this.item as unknown as Locator;
  }
}

class CandidatePage {
  public constructor(
    private readonly disabled: CandidateItem,
    private readonly enabled: CandidateItem,
  ) {}

  public on(_event: string, _listener: (...args: unknown[]) => void): this { return this; }
  public getByRole(): Locator {
    return new CandidateCollection(this.disabled) as unknown as Locator;
  }
  public getByPlaceholder(): Locator {
    return new CandidateCollection(this.enabled) as unknown as Locator;
  }
  public asPage(): Page { return this as unknown as Page; }
}

class BlockingSemanticPage implements SemanticPage {
  public fillCalls = 0;
  public activationCalls = 0;

  public async currentUrl(): Promise<string> {
    return "https://m365.cloud.microsoft/chat/conversation/synthetic";
  }

  public async snapshot(group: LocatorGroup): Promise<GroupSnapshot> {
    const readySignal = new Set<CopilotSignal>([
      "shell",
      "conversation",
      "composer",
      "send",
      "identity",
      "protection",
    ]).has(group.signal);
    if (group.signal === "modal") {
      return groupSnapshot(group.signal, true, true, "Microsoft dialog");
    }
    if (!readySignal) return groupSnapshot(group.signal, false, false);
    const text = group.signal === "identity"
      ? "Synthetic Work Account"
      : group.signal === "protection"
        ? "enterprise data protection"
        : group.signal;
    return groupSnapshot(group.signal, true, true, text);
  }

  public async fill(_group: LocatorGroup, _value: string): Promise<void> {
    this.fillCalls += 1;
  }
  public async click(_group: LocatorGroup): Promise<void> {
    this.activationCalls += 1;
  }
  public async press(_group: LocatorGroup, _key: "Enter"): Promise<void> {
    this.activationCalls += 1;
  }
}
