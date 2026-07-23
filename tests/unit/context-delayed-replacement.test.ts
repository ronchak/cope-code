import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { BrowserContext, Page, Response } from "playwright-core";

import { CopilotBrowserAdapter } from "../../src/browser/copilot-browser-adapter.js";
import { openTrackedCopilotPage } from "../../src/browser/context-semantic-page.js";
import { waitForStableManualReadiness } from "../../src/browser/manual-readiness.js";
import {
  createBaselineCopilotUiContract,
  type EdgeLaunchConfig,
} from "../../src/browser/config.js";
import { AgentError } from "../../src/shared/errors.js";

class DelayedPage {
  public closed = false;
  public onGoto?: () => Promise<Response | null>;
  public onBringToFront?: () => void;
  public popupListener?: (value: unknown) => void;
  public frameNavigationListener?: (value: unknown) => void;
  public bringToFrontCalls = 0;
  readonly #mainFrame = {};

  public constructor(public currentUrl: string) {}

  public url(): string { return this.currentUrl; }
  public isClosed(): boolean { return this.closed; }
  public async bringToFront(): Promise<void> {
    this.bringToFrontCalls += 1;
    this.onBringToFront?.();
  }
  public setDefaultTimeout(_milliseconds: number): void {}
  public setDefaultNavigationTimeout(_milliseconds: number): void {}
  public mainFrame(): object { return this.#mainFrame; }
  public on(event: string, listener: (value: unknown) => void): this {
    if (event === "popup") this.popupListener = listener;
    if (event === "framenavigated") this.frameNavigationListener = listener;
    return this;
  }
  public emitPopup(page: DelayedPage): void {
    this.popupListener?.(page.asPage());
  }
  public emitMainFrameNavigation(url: string): void {
    this.currentUrl = url;
    this.frameNavigationListener?.(this.#mainFrame);
  }
  public async goto(url: string): Promise<Response | null> {
    if (this.onGoto !== undefined) return this.onGoto();
    this.currentUrl = url;
    return null;
  }
  public asPage(): Page { return this as unknown as Page; }
}

class DelayedContext {
  public readonly pageList: DelayedPage[] = [new DelayedPage("about:blank")];
  public navigationPage = new DelayedPage("about:blank");
  public pageListener?: (page: Page) => void;
  public onPages?: (call: number) => void;
  public pageCalls = 0;

  public pages(): Page[] {
    this.pageCalls += 1;
    this.onPages?.(this.pageCalls);
    return this.pageList.map((page) => page.asPage());
  }
  public on(event: string, listener: (page: Page) => void): this {
    if (event === "page") this.pageListener = listener;
    return this;
  }
  public addPage(page: DelayedPage): void {
    this.pageList.push(page);
    this.pageListener?.(page.asPage());
  }
  public async newPage(): Promise<Page> {
    this.pageList.push(this.navigationPage);
    return this.navigationPage.asPage();
  }
  public asContext(): BrowserContext { return this as unknown as BrowserContext; }
}

test("a replacement Copilot tab arriving just after navigation abort is still adopted", async () => {
  const context = new DelayedContext();
  const replacement = new DelayedPage(
    "https://m365.cloud.microsoft/chat/conversation/delayed",
  );
  context.navigationPage.onGoto = async () => {
    void delay(20).then(() => { context.pageList.push(replacement); });
    throw new Error("net::ERR_ABORTED");
  };

  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  assert.equal(await tracked.currentUrl(), replacement.currentUrl);
});

test("an adopted replacement Copilot tab can anchor its tenant SSO popup", async () => {
  const context = new DelayedContext();
  const replacement = new DelayedPage(
    "https://m365.cloud.microsoft/chat/conversation/replacement",
  );
  context.navigationPage.onGoto = async () => {
    context.addPage(replacement);
    throw new Error("net::ERR_ABORTED");
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  context.addPage(sso);
  replacement.emitPopup(sso);

  assert.equal(await tracked.holdForManualAuthenticationHandoff(), true);
  await assert.rejects(tracked.currentUrl(), manualSsoHandoffError);
  assert.equal(tracked.isManualAuthenticationRedirect(), true);
});

test("an adopted replacement Copilot tab retains same-tab tenant SSO ownership", async () => {
  const context = new DelayedContext();
  const replacement = new DelayedPage(
    "https://m365.cloud.microsoft/chat/conversation/replacement",
  );
  context.navigationPage.onGoto = async () => {
    context.addPage(replacement);
    throw new Error("net::ERR_ABORTED");
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  replacement.currentUrl = "https://identity.example.test/sso/login";
  assert.equal(await tracked.holdForManualAuthenticationHandoff(), true);
  await assert.rejects(tracked.currentUrl(), manualSsoHandoffError);
  assert.equal(tracked.isManualAuthenticationRedirect(), true);

  replacement.currentUrl = "https://m365.cloud.microsoft/chat/conversation/returned";
  assert.equal(await tracked.holdForManualAuthenticationHandoff(), false);
  assert.equal(await tracked.currentUrl(), replacement.currentUrl);
});

test("an adopted Microsoft auth replacement retains federated tenant SSO ownership", async () => {
  const context = new DelayedContext();
  const replacement = new DelayedPage(
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  );
  context.navigationPage.onGoto = async () => {
    context.addPage(replacement);
    throw new Error("net::ERR_ABORTED");
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  replacement.currentUrl = "https://identity.example.test/sso/login";
  assert.equal(await tracked.holdForManualAuthenticationHandoff(), true);
  await assert.rejects(tracked.currentUrl(), manualSsoHandoffError);
  assert.equal(tracked.isManualAuthenticationRedirect(), true);

  replacement.currentUrl = "https://m365.cloud.microsoft/chat/conversation/returned";
  assert.equal(await tracked.holdForManualAuthenticationHandoff(), false);
  assert.equal(await tracked.currentUrl(), replacement.currentUrl);
});

test("a fast replacement federation records its trusted waypoint before final selection", async () => {
  for (const trustedUrl of [
    "https://m365.cloud.microsoft/chat/conversation/replacement",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  ]) {
    const context = new DelayedContext();
    const replacement = new DelayedPage("about:blank");
    context.navigationPage.onGoto = async () => {
      context.addPage(replacement);
      replacement.emitMainFrameNavigation(trustedUrl);
      replacement.emitMainFrameNavigation("https://identity.example.test/sso/login");
      throw new Error("net::ERR_ABORTED");
    };

    const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());
    assert.equal(await tracked.holdForManualAuthenticationHandoff(), true);
    await assert.rejects(tracked.currentUrl(), manualSsoHandoffError);
    assert.equal(tracked.isManualAuthenticationRedirect(), true);

    replacement.emitMainFrameNavigation(
      "https://m365.cloud.microsoft/chat/conversation/returned",
    );
    assert.equal(await tracked.holdForManualAuthenticationHandoff(), false);
    assert.equal(await tracked.currentUrl(), replacement.currentUrl);
  }
});

test("an external tenant SSO redirect on the tracked setup page remains open for manual sign-in", async () => {
  const context = new DelayedContext();
  const ssoUrl = "https://identity.example.test/sso/login";
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = ssoUrl;
    return null;
  };

  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  await assert.rejects(tracked.currentUrl(), manualSsoHandoffError);
  assert.equal(tracked.isManualAuthenticationRedirect(), true);
});

test("an external tenant SSO popup opened by the tracked setup context receives manual ownership", async () => {
  const context = new DelayedContext();
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(sso);
    context.navigationPage.emitPopup(sso);
    return null;
  };

  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  await assert.rejects(tracked.currentUrl(), manualSsoHandoffError);
  assert.equal(tracked.isManualAuthenticationRedirect(), true);
});

test("an unrelated context page without a tracked popup opener never receives SSO ownership", async () => {
  const context = new DelayedContext();
  const unrelated = new DelayedPage("https://unrelated.example.test/");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(unrelated);
    return null;
  };

  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  assert.equal(await tracked.currentUrl(), context.navigationPage.currentUrl);
  assert.equal(tracked.isManualAuthenticationRedirect(), false);
});

test("setup can inspect a configured popup callback while ordinary operations stay blocked", async () => {
  const context = new DelayedContext();
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(sso);
    context.navigationPage.emitPopup(sso);
    return null;
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());
  assert.equal(await tracked.holdForManualAuthenticationHandoff(), true);

  sso.currentUrl = "https://m365.cloud.microsoft/chat/callback";
  assert.equal(await tracked.holdForManualAuthenticationHandoff(), true);
  await tracked.withManualReadinessProbe(async () => {
    assert.equal(
      await tracked.holdForManualAuthenticationHandoff(false, true),
      false,
      "setup must inspect the provenance-bound callback page instead of waiting for it to close",
    );
    assert.equal(await tracked.currentUrl(), sso.currentUrl);
    assert.deepEqual(await tracked.completeObservation(), { nativeDialogDetected: false });
  });
  await assert.rejects(
    tracked.currentUrl(),
    /Multiple approved Copilot pages/u,
    "ordinary semantic inspection must remain fail-closed during callback overlap",
  );

  sso.closed = true;
  assert.equal(await tracked.holdForManualAuthenticationHandoff(), false);
  assert.equal(await tracked.currentUrl(), context.navigationPage.currentUrl);
});

test("setup never treats an ordinary configured popup as a completed SSO callback", async () => {
  const context = new DelayedContext();
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    return null;
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());
  const ordinaryPopup = new DelayedPage(
    "https://m365.cloud.microsoft/chat/conversation/ordinary-popup",
  );
  context.addPage(ordinaryPopup);
  context.navigationPage.emitPopup(ordinaryPopup);

  assert.equal(
    await tracked.holdForManualAuthenticationHandoff(),
    false,
    "opener provenance alone must not create an SSO callback handoff",
  );
  await tracked.withManualReadinessProbe(async () => {
    assert.equal(
      await tracked.holdForManualAuthenticationHandoff(false, true),
      false,
    );
    await assert.rejects(
      tracked.currentUrl(),
      /Multiple approved Copilot pages/u,
      "setup must preserve ordinary configured-page ambiguity",
    );
  });
});

test("setup requires a returned SSO popup to overlap its original configured opener", async () => {
  const context = new DelayedContext();
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(sso);
    context.navigationPage.emitPopup(sso);
    return null;
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());
  sso.emitMainFrameNavigation("https://m365.cloud.microsoft/chat/callback");
  context.navigationPage.closed = true;
  const unrelatedConfiguredPage = new DelayedPage(
    "https://m365.cloud.microsoft/chat/conversation/unrelated",
  );
  context.addPage(unrelatedConfiguredPage);

  assert.equal(
    await tracked.holdForManualAuthenticationHandoff(),
    false,
    "an unrelated configured page cannot replace the callback popup's opener",
  );
  await tracked.withManualReadinessProbe(async () => {
    assert.equal(
      await tracked.holdForManualAuthenticationHandoff(false, true),
      false,
    );
    await assert.rejects(
      tracked.currentUrl(),
      /Multiple approved Copilot pages/u,
      "setup must preserve ambiguity when the original opener is gone",
    );
  });
});

test("an external SSO success popup retains manual ownership until it closes", async () => {
  const context = new DelayedContext();
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(sso);
    context.navigationPage.emitPopup(sso);
    return null;
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  sso.currentUrl = "https://identity.example.test/sso/success";
  assert.equal(await tracked.holdForManualAuthenticationHandoff(), true);
  const configuredForegrounds = context.navigationPage.bringToFrontCalls;
  assert.equal(
    await tracked.holdForManualAuthenticationHandoff(false, true),
    false,
    "setup may inspect the unique configured page behind a lingering external popup",
  );
  assert.equal(
    context.navigationPage.bringToFrontCalls,
    configuredForegrounds,
    "the setup-only probe must not steal focus from the operator's SSO popup",
  );
  assert.equal(await tracked.currentUrl(), context.navigationPage.currentUrl);
  assert.deepEqual(await tracked.completeObservation(), { nativeDialogDetected: false });
  assert.equal(
    await tracked.holdForManualAuthenticationHandoff(),
    true,
    "ordinary readiness remains blocked while the external popup is open",
  );
  sso.closed = true;
  assert.equal(await tracked.holdForManualAuthenticationHandoff(), false);
});

test("an SSO popup closing during foreground adoption is treated as completed handoff", async () => {
  const context = new DelayedContext();
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(sso);
    context.navigationPage.emitPopup(sso);
    return null;
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  await tracked.holdForManualAuthenticationHandoff(false, true);
  const priorForegrounds = sso.bringToFrontCalls;
  sso.onBringToFront = () => { sso.closed = true; };
  assert.equal(await tracked.holdForManualAuthenticationHandoff(), true);
  assert.equal(sso.bringToFrontCalls, priorForegrounds + 1);
  assert.equal(tracked.isManualAuthenticationRedirect(), false);
  assert.equal(await tracked.holdForManualAuthenticationHandoff(), false);
});

test("a callback overlap before setup currentUrl is a retryable page transition", async () => {
  const context = new DelayedContext();
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(sso);
    context.navigationPage.emitPopup(sso);
    return null;
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  await tracked.withManualReadinessProbe(async () => {
    assert.equal(await tracked.holdForManualAuthenticationHandoff(false, true), false);
    sso.currentUrl = "https://m365.cloud.microsoft/chat/callback";
    await assert.rejects(
      tracked.currentUrl(),
      retryableReadinessTransition,
    );
  });
});

test("a callback overlap during setup observation is a retryable page transition", async () => {
  const context = new DelayedContext();
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(sso);
    context.navigationPage.emitPopup(sso);
    return null;
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  await tracked.withManualReadinessProbe(async () => {
    assert.equal(await tracked.holdForManualAuthenticationHandoff(false, true), false);
    assert.equal(await tracked.currentUrl(), context.navigationPage.currentUrl);
    sso.currentUrl = "https://m365.cloud.microsoft/chat/callback";
    await assert.rejects(
      tracked.completeObservation(),
      retryableReadinessTransition,
    );
  });
});

test("a configured callback pair changing during setup invalidates the readiness sample", async () => {
  const context = new DelayedContext();
  const callback = new DelayedPage("https://identity.example.test/sso/login");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(callback);
    context.navigationPage.emitPopup(callback);
    return null;
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());
  callback.currentUrl = "https://m365.cloud.microsoft/chat/callback";

  await tracked.withManualReadinessProbe(async () => {
    assert.equal(await tracked.holdForManualAuthenticationHandoff(false, true), false);
    assert.equal(await tracked.currentUrl(), callback.currentUrl);
    context.navigationPage.closed = true;
    await assert.rejects(
      tracked.completeObservation(),
      retryableReadinessTransition,
    );
  });
});

test("new authentication before a callback probe DOM read invalidates the sample", async () => {
  const context = new DelayedContext();
  const callback = new DelayedPage("https://identity.example.test/sso/login");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(callback);
    context.navigationPage.emitPopup(callback);
    return null;
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());
  callback.currentUrl = "https://m365.cloud.microsoft/chat/callback";

  await tracked.withManualReadinessProbe(async () => {
    assert.equal(await tracked.holdForManualAuthenticationHandoff(false, true), false);
    const nextAuth = new DelayedPage("https://identity.example.test/sso/continue");
    context.addPage(nextAuth);
    callback.emitPopup(nextAuth);
    await assert.rejects(
      tracked.currentUrl(),
      authenticationPrecedenceTransition,
    );
  });
});

test("an existing page navigating to authentication during a callback probe invalidates the sample", async () => {
  const context = new DelayedContext();
  const callback = new DelayedPage("https://identity.example.test/sso/login");
  const nextAuth = new DelayedPage("about:blank");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(callback);
    context.navigationPage.emitPopup(callback);
    context.addPage(nextAuth);
    callback.emitPopup(nextAuth);
    return null;
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());
  callback.currentUrl = "https://m365.cloud.microsoft/chat/callback";

  await tracked.withManualReadinessProbe(async () => {
    assert.equal(await tracked.holdForManualAuthenticationHandoff(false, true), false);
    assert.equal(await tracked.currentUrl(), callback.currentUrl);
    nextAuth.emitMainFrameNavigation(
      "https://login.microsoftonline.com/common/oauth2/authorize",
    );
    await assert.rejects(
      tracked.completeObservation(),
      authenticationPrecedenceTransition,
    );
  });
});

test("a cancelled setup probe cannot affect the next ordinary inspection", async () => {
  const context = new DelayedContext();
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(sso);
    context.navigationPage.emitPopup(sso);
    return null;
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  await assert.rejects(
    tracked.withManualReadinessProbe(async () => {
      assert.equal(await tracked.holdForManualAuthenticationHandoff(false, true), false);
      throw new Error("synthetic cancellation");
    }),
    /synthetic cancellation/u,
  );
  await assert.rejects(
    tracked.currentUrl(),
    manualSsoHandoffError,
    "ordinary inspection must remain source-free during external-popup ownership",
  );
});

test("an SSO popup appearing after the setup precheck is rejected before IdP inspection", async () => {
  const context = new DelayedContext();
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    return null;
  };
  const config = browserConfig();
  const tracked = await openTrackedCopilotPage(context.asContext(), config);
  const {
    product: _product,
    browserContractVersion: _browserContractVersion,
    browserExecutable: _browserExecutable,
    profileDirectory: _profileDirectory,
    ...adapterConfig
  } = config;
  const adapter = new CopilotBrowserAdapter(tracked, adapterConfig);
  const sso = new DelayedPage("https://identity.example.test/sso/login");

  await assert.rejects(
    tracked.withManualReadinessProbe(() =>
      adapter.inspectManualReadinessState(async () => {
        assert.equal(await tracked.holdForManualAuthenticationHandoff(false, true), false);
        context.addPage(sso);
        context.navigationPage.emitPopup(sso);
        return false;
      })),
    retryableReadinessTransition,
  );
  assert.equal(
    sso.bringToFrontCalls,
    0,
    "the raced IdP must not be foregrounded or reach semantic inspection",
  );
});

test("ordinary inspect and submit stop before reading a provenance-bound IdP page", async () => {
  const context = new DelayedContext();
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(sso);
    context.navigationPage.emitPopup(sso);
    return null;
  };
  const config = browserConfig();
  const tracked = await openTrackedCopilotPage(context.asContext(), config);
  const {
    product: _product,
    browserContractVersion: _browserContractVersion,
    browserExecutable: _browserExecutable,
    profileDirectory: _profileDirectory,
    ...adapterConfig
  } = config;
  const adapter = new CopilotBrowserAdapter(tracked, adapterConfig);
  const priorForegrounds = sso.bringToFrontCalls;

  await assert.rejects(adapter.inspectState(), manualSsoHandoffError);
  await assert.rejects(
    adapter.submit({
      taskId: "task-external-idp",
      turnId: "turn-external-idp",
      submissionId: "submission-external-idp",
      content: "must not be disclosed",
    }),
    manualSsoHandoffError,
  );
  assert.equal(
    sso.bringToFrontCalls,
    priorForegrounds,
    "ordinary semantic operations must stop before IdP focus or DOM access",
  );
});

test("ordinary inspection stops if an SSO popup appears during page selection", async () => {
  const context = new DelayedContext();
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    return null;
  };
  const config = browserConfig();
  const tracked = await openTrackedCopilotPage(context.asContext(), config);
  const {
    product: _product,
    browserContractVersion: _browserContractVersion,
    browserExecutable: _browserExecutable,
    profileDirectory: _profileDirectory,
    ...adapterConfig
  } = config;
  const adapter = new CopilotBrowserAdapter(tracked, adapterConfig);
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  const injectOnPageCall = context.pageCalls + 3;
  context.onPages = (call) => {
    if (call !== injectOnPageCall) return;
    context.addPage(sso);
    context.navigationPage.emitPopup(sso);
  };

  await assert.rejects(adapter.inspectState(), manualSsoHandoffError);
  assert.equal(sso.bringToFrontCalls, 0);
});

test("runtime manual readiness retries an SSO popup racing its precheck", async () => {
  const context = new DelayedContext();
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    return null;
  };
  const config = browserConfig();
  const tracked = await openTrackedCopilotPage(context.asContext(), config);
  const {
    product: _product,
    browserContractVersion: _browserContractVersion,
    browserExecutable: _browserExecutable,
    profileDirectory: _profileDirectory,
    ...adapterConfig
  } = config;
  const adapter = new CopilotBrowserAdapter(tracked, adapterConfig);
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  let injectAfterFirstPrecheck = true;
  let monotonicNow = 0;

  const inspection = await waitForStableManualReadiness(
    () => tracked.withManualReadinessProbe(() =>
      adapter.inspectManualReadinessState(async () => {
        const held = await tracked.holdForManualAuthenticationHandoff();
        if (injectAfterFirstPrecheck) {
          injectAfterFirstPrecheck = false;
          context.addPage(sso);
          context.navigationPage.emitPopup(sso);
        }
        return held;
      })),
    config.waits,
    100,
    undefined,
    {
      monotonicNow: () => monotonicNow,
      sleep: async (milliseconds) => { monotonicNow += milliseconds; },
    },
  );

  assert.equal(inspection.classification.diagnosticCode, "MANUAL_SSO_HANDOFF");
  assert.equal(
    sso.bringToFrontCalls,
    1,
    "the retried manual wait may foreground the IdP without snapshotting it",
  );
});

test("a configured replacement adopted behind SSO retains later same-tab handoff ownership", async () => {
  const context = new DelayedContext();
  const sso = new DelayedPage("https://identity.example.test/sso/login");
  const replacement = new DelayedPage(
    "https://m365.cloud.microsoft/chat/conversation/replacement",
  );
  context.navigationPage.onGoto = async () => {
    context.navigationPage.currentUrl = "https://m365.cloud.microsoft/chat";
    context.addPage(sso);
    context.navigationPage.emitPopup(sso);
    return null;
  };
  const tracked = await openTrackedCopilotPage(context.asContext(), browserConfig());

  context.navigationPage.closed = true;
  context.addPage(replacement);
  await tracked.withManualReadinessProbe(async () => {
    assert.equal(await tracked.holdForManualAuthenticationHandoff(false, true), false);
    assert.equal(await tracked.currentUrl(), replacement.currentUrl);
    assert.deepEqual(await tracked.completeObservation(), { nativeDialogDetected: false });
  });

  sso.closed = true;
  replacement.currentUrl = "https://identity.example.test/sso/continue";
  assert.equal(await tracked.holdForManualAuthenticationHandoff(), true);
  await assert.rejects(tracked.currentUrl(), manualSsoHandoffError);
});

function retryableReadinessTransition(error: unknown): boolean {
  return error instanceof Error &&
    "details" in error &&
    (error as { details?: Record<string, unknown> }).details?.diagnosticCode ===
      "ACTIVE_PAGE_CHANGED_DURING_OBSERVATION" &&
    (error as { details?: Record<string, unknown> }).details?.dispatchAttempted === false;
}

function authenticationPrecedenceTransition(error: unknown): boolean {
  return retryableReadinessTransition(error) &&
    (error as { details?: Record<string, unknown> }).details?.observationChangeReason ===
      "authentication-precedence";
}

function manualSsoHandoffError(error: unknown): boolean {
  return error instanceof AgentError &&
    error.details.diagnosticCode === "MANUAL_SSO_HANDOFF" &&
    error.details.dispatchAttempted === false;
}

function browserConfig(): EdgeLaunchConfig {
  const expectedIdentity = "Ronak Chakraborty";
  return {
    product: "edge",
    browserContractVersion: "cope-visible-browser/v1",
    browserExecutable: path.resolve("synthetic-edge-executable"),
    entryUrl: "https://m365.cloud.microsoft/chat",
    approvedHosts: [{ hostname: "m365.cloud.microsoft" }],
    manualAuthenticationHosts: [{ hostname: "login.microsoftonline.com" }],
    uiContract: createBaselineCopilotUiContract(expectedIdentity),
    expectedIdentity,
    requireProtectionIndicator: false,
    maxMessageChars: 10_000,
    maxResponseChars: 10_000,
    waits: {
      actionMs: 500,
      submissionConfirmationMs: 500,
      responseMs: 1_000,
      manualReadinessMs: 2_000,
      pollMs: 50,
      stableSamples: 3,
      minimumStableMs: 150,
    },
    profileDirectory: path.resolve("synthetic-delayed-edge-profile"),
  };
}
